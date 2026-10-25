import { Hono } from 'hono';
import { z } from 'zod';
import { one, run } from '../db.ts';
import { notFound, validation } from '../errors.ts';
import { recordEmailEvent } from '../events.ts';
import { enqueueEmail, type NewEmail } from '../mail/queue.ts';
import { serializeEmail, type ApiKeyRow, type EmailRow, type StoredAttachment } from '../models.ts';
import { parseScheduledAt, toArray } from '../util.ts';
import { wakeWorker } from '../worker.ts';
import { address, addressList, assertSendableFrom, paginate, parseWith, readJson, type ApiEnv } from './shared.ts';

const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_SCHEDULE_DAYS = 30;

const tagPart = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Tags can only contain ASCII letters (a–z, A–Z), numbers (0–9), underscores (_), or dashes (-).');

// The SDK JSON-serialises Buffers as { type: 'Buffer', data: [...] }.
const bufferJson = z.object({ type: z.literal('Buffer'), data: z.array(z.number()) });

const attachmentSchema = z.object({
  content: z.union([z.string(), bufferJson]).nullish(),
  filename: z.string().nullish(),
  path: z.string().nullish(),
  content_type: z.string().nullish(),
  content_id: z.string().nullish(),
});

export const emailSchema = z.object({
  from: address,
  to: addressList,
  subject: z.string(),
  cc: addressList.nullish(),
  bcc: addressList.nullish(),
  reply_to: addressList.nullish(),
  html: z.string().nullish(),
  text: z.string().nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
  tags: z.array(z.object({ name: tagPart, value: tagPart })).nullish(),
  attachments: z.array(attachmentSchema).nullish(),
  scheduled_at: z.string().nullish(),
  template: z.unknown().optional(),
  topic_id: z.unknown().optional(),
});

function prepareAttachments(input: z.infer<typeof attachmentSchema>[]): StoredAttachment[] {
  let total = 0;
  const attachments = input.map((a, index): StoredAttachment => {
    if (!a.content && !a.path) throw validation(`Invalid \`attachments.${index}\` field. Provide either \`content\` or \`path\`.`);
    if (a.path && !/^https?:\/\//i.test(a.path)) throw validation(`Invalid \`attachments.${index}.path\` field. It must be an http(s) URL.`);
    let content: string | undefined;
    if (a.content) {
      const bytes = typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : Buffer.from(a.content.data);
      total += bytes.length;
      content = bytes.toString('base64');
    }
    return {
      filename: a.filename ?? undefined,
      content,
      path: a.path ?? undefined,
      content_type: a.content_type ?? undefined,
      content_id: a.content_id ?? undefined,
    };
  });
  if (total > MAX_ATTACHMENT_BYTES) throw validation('Attachments exceed the 40MB limit.');
  return attachments;
}

export function prepareEmail(body: unknown, apiKey: ApiKeyRow, allowAttachments: boolean): NewEmail {
  const input = parseWith(emailSchema, body);
  if (input.template !== undefined) {
    throw validation('Templates are not supported by this server. Render the template client-side and send `html`.');
  }
  if (!input.html && !input.text) throw validation('Missing `html` or `text` field.');
  const to = toArray(input.to);
  if (to.length === 0) throw validation('Missing `to` field.');
  if (to.length > MAX_RECIPIENTS) throw validation(`Too many recipients in \`to\`. The maximum is ${MAX_RECIPIENTS}.`);
  if (input.attachments?.length && !allowAttachments) throw validation('Attachments are not supported in batch sends.');
  assertSendableFrom(input.from, apiKey);

  let scheduledAt: Date | null = null;
  if (input.scheduled_at) {
    scheduledAt = parseScheduledAt(input.scheduled_at);
    if (!scheduledAt) throw validation('Invalid `scheduled_at` field. Use ISO 8601 or natural language such as "in 1 hour".');
    if (scheduledAt.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 864e5) {
      throw validation(`Emails can be scheduled at most ${MAX_SCHEDULE_DAYS} days in advance.`);
    }
  }

  return {
    from: input.from,
    to,
    cc: toArray(input.cc),
    bcc: toArray(input.bcc),
    replyTo: toArray(input.reply_to),
    subject: input.subject,
    html: input.html,
    text: input.text,
    headers: input.headers ?? undefined,
    tags: input.tags ?? undefined,
    attachments: input.attachments ? prepareAttachments(input.attachments) : undefined,
    scheduledAt,
  };
}

function findEmail(id: string): EmailRow {
  const email = one<EmailRow>('SELECT * FROM emails WHERE id = ?', id);
  if (!email) throw notFound('Email');
  return email;
}

export const emails = new Hono<ApiEnv>();

emails.post('/', async (c) => {
  const email = prepareEmail(await readJson(c), c.get('apiKey'), true);
  const id = enqueueEmail(email);
  wakeWorker();
  return c.json({ id });
});

emails.post('/batch', async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body)) throw validation('The batch body must be an array of emails.');
  if (body.length === 0 || body.length > 100) throw validation('A batch must contain between 1 and 100 emails.');
  const permissive = c.req.header('x-batch-validation') === 'permissive';

  const prepared: (NewEmail | null)[] = [];
  const errors: { index: number; message: string }[] = [];
  body.forEach((item, index) => {
    try {
      prepared.push(prepareEmail(item, c.get('apiKey'), false));
    } catch (err) {
      if (!permissive) {
        throw validation(`Email at index ${index}: ${err instanceof Error ? err.message : String(err)}`);
      }
      prepared.push(null);
      errors.push({ index, message: err instanceof Error ? err.message : String(err) });
    }
  });
  const data = prepared.filter((e): e is NewEmail => e !== null).map((email) => ({ id: enqueueEmail(email) }));
  wakeWorker();
  return c.json(permissive ? { data, errors } : { data });
});

emails.get('/', (c) => {
  const page = paginate<EmailRow>(c, 'emails');
  return c.json({ ...page, data: page.data.map((row) => serializeEmail(row, false)) });
});

emails.get('/:id', (c) => c.json(serializeEmail(findEmail(c.req.param('id')))));

emails.patch('/:id', async (c) => {
  const email = findEmail(c.req.param('id'));
  const { scheduled_at } = parseWith(z.object({ scheduled_at: z.string() }), await readJson(c));
  if (email.status !== 'scheduled') throw validation('Only scheduled emails can be updated.');
  const date = parseScheduledAt(scheduled_at);
  if (!date) throw validation('Invalid `scheduled_at` field.');
  run('UPDATE emails SET scheduled_at = ?, send_after = ? WHERE id = ?', date.toISOString(), date.toISOString(), email.id);
  return c.json({ object: 'email', id: email.id });
});

emails.post('/:id/cancel', (c) => {
  const email = findEmail(c.req.param('id'));
  if (email.status !== 'scheduled') throw validation('Only scheduled emails can be canceled.');
  run("UPDATE emails SET status = 'canceled' WHERE id = ?", email.id);
  recordEmailEvent(email.id, 'canceled');
  return c.json({ object: 'email', id: email.id });
});

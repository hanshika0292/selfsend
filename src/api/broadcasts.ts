import { Hono } from 'hono';
import { z } from 'zod';
import { one, run } from '../db.ts';
import { notFound, validation } from '../errors.ts';
import { serializeBroadcast, type ApiKeyRow, type BroadcastRow } from '../models.ts';
import { now, parseScheduledAt, toArray, uuidv7 } from '../util.ts';
import { wakeWorker } from '../worker.ts';
import { findSegment } from './contacts.ts';
import { address, addressList, assertSendableFrom, paginate, parseWith, readJson, type ApiEnv } from './shared.ts';

const fields = {
  name: z.string().nullish(),
  segment_id: z.string().nullish(),
  audience_id: z.string().nullish(),
  from: address.nullish(),
  subject: z.string().nullish(),
  reply_to: addressList.nullish(),
  preview_text: z.string().nullish(),
  html: z.string().nullish(),
  text: z.string().nullish(),
  topic_id: z.unknown().optional(),
};
const createSchema = z.object({ ...fields, send: z.boolean().nullish(), scheduled_at: z.string().nullish() });
const updateSchema = z.object(fields);

export type BroadcastInput = z.input<typeof createSchema>;

export function findBroadcast(id: string): BroadcastRow {
  const broadcast = one<BroadcastRow>('SELECT * FROM broadcasts WHERE id = ?', id);
  if (!broadcast) throw notFound('Broadcast');
  return broadcast;
}

export function createBroadcast(input: BroadcastInput, apiKey: ApiKeyRow | null): BroadcastRow {
  const data = parseWith(createSchema, input);
  const segmentId = data.segment_id ?? data.audience_id ?? null;
  if (segmentId) findSegment(segmentId);
  const id = uuidv7();
  run(
    `INSERT INTO broadcasts (id, name, segment_id, from_addr, subject, reply_to, preview_text, html, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    data.name ?? null,
    segmentId,
    data.from ?? null,
    data.subject ?? null,
    data.reply_to ? JSON.stringify(toArray(data.reply_to)) : null,
    data.preview_text ?? null,
    data.html ?? null,
    data.text ?? null,
    now(),
  );
  if (data.send) return sendBroadcast(findBroadcast(id), data.scheduled_at ?? null, apiKey);
  return findBroadcast(id);
}

export function updateBroadcast(broadcast: BroadcastRow, input: unknown): BroadcastRow {
  if (broadcast.status !== 'draft') throw validation('Only draft broadcasts can be updated.');
  const data = parseWith(updateSchema, input);
  const segmentId = data.segment_id ?? data.audience_id;
  if (segmentId) findSegment(segmentId);
  run(
    `UPDATE broadcasts SET name = ?, segment_id = ?, from_addr = ?, subject = ?, reply_to = ?, preview_text = ?, html = ?, text = ?
      WHERE id = ?`,
    data.name ?? broadcast.name,
    segmentId ?? broadcast.segment_id,
    data.from ?? broadcast.from_addr,
    data.subject ?? broadcast.subject,
    data.reply_to ? JSON.stringify(toArray(data.reply_to)) : broadcast.reply_to,
    data.preview_text ?? broadcast.preview_text,
    data.html ?? broadcast.html,
    data.text ?? broadcast.text,
    broadcast.id,
  );
  return findBroadcast(broadcast.id);
}

/** Validates a draft and queues it; the worker fans it out to the segment at `scheduled_at` (or immediately). */
export function sendBroadcast(broadcast: BroadcastRow, scheduledAt: string | null, apiKey: ApiKeyRow | null): BroadcastRow {
  if (broadcast.status !== 'draft') throw validation('This broadcast has already been sent or scheduled.');
  if (!broadcast.segment_id) throw validation('Missing `segment_id` field.');
  if (!broadcast.from_addr) throw validation('Missing `from` field.');
  if (!broadcast.subject) throw validation('Missing `subject` field.');
  if (!broadcast.html && !broadcast.text) throw validation('Missing `html` or `text` field.');
  assertSendableFrom(broadcast.from_addr, apiKey);
  let when: string | null = null;
  if (scheduledAt) {
    const date = parseScheduledAt(scheduledAt);
    if (!date) throw validation('Invalid `scheduled_at` field.');
    when = date.toISOString();
  }
  run("UPDATE broadcasts SET status = 'queued', scheduled_at = ? WHERE id = ?", when, broadcast.id);
  wakeWorker();
  return findBroadcast(broadcast.id);
}

export const broadcasts = new Hono<ApiEnv>();

broadcasts.post('/', async (c) => c.json({ id: createBroadcast((await readJson(c)) as BroadcastInput, c.get('apiKey')).id }));

broadcasts.get('/', (c) => {
  const page = paginate<BroadcastRow>(c, 'broadcasts');
  return c.json({
    ...page,
    data: page.data.map(({ html: _h, text: _t, ...rest }) => serializeBroadcast({ ...rest, html: null, text: null })),
  });
});

broadcasts.get('/:id', (c) => c.json(serializeBroadcast(findBroadcast(c.req.param('id')))));

broadcasts.patch('/:id', async (c) => c.json({ id: updateBroadcast(findBroadcast(c.req.param('id')), await readJson(c)).id }));

broadcasts.post('/:id/send', async (c) => {
  const { scheduled_at } = parseWith(z.object({ scheduled_at: z.string().nullish() }), await readJson(c));
  const broadcast = sendBroadcast(findBroadcast(c.req.param('id')), scheduled_at ?? null, c.get('apiKey'));
  return c.json({ id: broadcast.id });
});

broadcasts.delete('/:id', (c) => {
  const broadcast = findBroadcast(c.req.param('id'));
  if (broadcast.status === 'sent') throw validation('Sent broadcasts cannot be deleted.');
  run('DELETE FROM broadcasts WHERE id = ?', broadcast.id);
  return c.json({ object: 'broadcast', id: broadcast.id, deleted: true });
});

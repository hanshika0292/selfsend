import { Hono } from 'hono';
import { z } from 'zod';
import { one, run } from '../db.ts';
import { notFound } from '../errors.ts';
import { serializeWebhook, type WebhookRow } from '../models.ts';
import { generateWebhookSecret, now, uuidv7 } from '../util.ts';
import { paginate, parseWith, readJson, type ApiEnv } from './shared.ts';

export const WEBHOOK_EVENTS = [
  'email.sent',
  'email.scheduled',
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.opened',
  'email.clicked',
  'email.failed',
  'email.suppressed',
  'email.canceled',
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'domain.created',
  'domain.updated',
  'domain.deleted',
] as const;

const endpoint = z.url({ protocol: /^https?$/ });
const createSchema = z.object({ endpoint, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) });
const updateSchema = z.object({
  endpoint: endpoint.nullish(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).nullish(),
  status: z.enum(['enabled', 'disabled']).nullish(),
});

export function findWebhook(id: string): WebhookRow {
  const hook = one<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', id);
  if (!hook) throw notFound('Webhook');
  return hook;
}

export function createWebhook(input: z.input<typeof createSchema>): WebhookRow {
  const data = parseWith(createSchema, input);
  const id = uuidv7();
  run(
    'INSERT INTO webhooks (id, endpoint, events, secret, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    data.endpoint,
    JSON.stringify(data.events),
    generateWebhookSecret(),
    now(),
  );
  return findWebhook(id);
}

export const webhooks = new Hono<ApiEnv>();

webhooks.post('/', async (c) => {
  const hook = createWebhook((await readJson(c)) as z.input<typeof createSchema>);
  return c.json({ object: 'webhook', id: hook.id, signing_secret: hook.secret });
});

webhooks.get('/', (c) => {
  const page = paginate<WebhookRow>(c, 'webhooks');
  return c.json({ ...page, data: page.data.map((row) => serializeWebhook(row, false)) });
});

webhooks.get('/:id', (c) => c.json(serializeWebhook(findWebhook(c.req.param('id')), true)));

webhooks.patch('/:id', async (c) => {
  const hook = findWebhook(c.req.param('id'));
  const data = parseWith(updateSchema, await readJson(c));
  run(
    'UPDATE webhooks SET endpoint = ?, events = ?, status = ? WHERE id = ?',
    data.endpoint ?? hook.endpoint,
    data.events ? JSON.stringify(data.events) : hook.events,
    data.status ?? hook.status,
    hook.id,
  );
  return c.json({ object: 'webhook', id: hook.id });
});

webhooks.delete('/:id', (c) => {
  const hook = findWebhook(c.req.param('id'));
  run('DELETE FROM webhooks WHERE id = ?', hook.id);
  return c.json({ object: 'webhook', id: hook.id, deleted: true });
});

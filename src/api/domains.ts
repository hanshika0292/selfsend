import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.ts';
import { one, run } from '../db.ts';
import { ApiError, notFound } from '../errors.ts';
import { dispatchWebhookEvent } from '../events.ts';
import { deprovisionDomain, inspectDomain, provisionDomain } from '../mail/domains.ts';
import { serializeDomain, type DomainRow } from '../models.ts';
import { now, uuidv7 } from '../util.ts';
import { paginate, parseWith, readJson, type ApiEnv } from './shared.ts';

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const createSchema = z.object({
  name: z.string().transform((v) => v.trim().toLowerCase()).refine((v) => HOSTNAME.test(v), 'Enter a valid domain name.'),
  region: z.string().nullish(),
  custom_return_path: z.string().regex(/^[a-z0-9-]{1,63}$/i).nullish(),
  open_tracking: z.boolean().nullish(),
  click_tracking: z.boolean().nullish(),
});

const updateSchema = z.object({
  open_tracking: z.boolean().nullish(),
  click_tracking: z.boolean().nullish(),
});

export function findDomain(id: string): DomainRow {
  const domain = one<DomainRow>('SELECT * FROM domains WHERE id = ?', id);
  if (!domain) throw notFound('Domain');
  return domain;
}

export async function createDomain(input: z.input<typeof createSchema>): Promise<DomainRow> {
  const data = parseWith(createSchema, input);
  if (one('SELECT 1 FROM domains WHERE name = ?', data.name)) {
    throw new ApiError(403, 'validation_error', `The domain ${data.name} has already been added.`);
  }
  const returnPath = data.custom_return_path ?? 'send';
  const state = await provisionDomain(data.name, returnPath);
  const id = uuidv7();
  run(
    `INSERT INTO domains (id, name, status, region, return_path, open_tracking, click_tracking, records, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    data.name,
    state.status,
    config.awsRegion,
    returnPath,
    data.open_tracking ?? false,
    data.click_tracking ?? false,
    JSON.stringify(state.records),
    now(),
  );
  const row = findDomain(id);
  dispatchWebhookEvent('domain.created', serializeDomain(row, true));
  return row;
}

export async function verifyDomain(domain: DomainRow): Promise<DomainRow> {
  const state = await inspectDomain(domain.name, domain.return_path);
  run('UPDATE domains SET status = ?, records = ? WHERE id = ?', state.status, JSON.stringify(state.records), domain.id);
  const updated = findDomain(domain.id);
  if (updated.status !== domain.status) dispatchWebhookEvent('domain.updated', serializeDomain(updated, true));
  return updated;
}

export async function removeDomain(domain: DomainRow): Promise<void> {
  await deprovisionDomain(domain.name);
  run('DELETE FROM domains WHERE id = ?', domain.id);
  dispatchWebhookEvent('domain.deleted', { id: domain.id, name: domain.name });
}

export const domains = new Hono<ApiEnv>();

domains.post('/', async (c) => {
  const row = await createDomain((await readJson(c)) as z.input<typeof createSchema>);
  const { object: _object, ...created } = serializeDomain(row, true);
  return c.json(created);
});

domains.get('/', (c) => {
  const page = paginate<DomainRow>(c, 'domains');
  return c.json({ ...page, data: page.data.map((row) => serializeDomain(row, false)) });
});

domains.get('/:id', (c) => c.json(serializeDomain(findDomain(c.req.param('id')), true)));

domains.patch('/:id', async (c) => {
  const domain = findDomain(c.req.param('id'));
  const data = parseWith(updateSchema, await readJson(c));
  run(
    'UPDATE domains SET open_tracking = ?, click_tracking = ? WHERE id = ?',
    data.open_tracking ?? domain.open_tracking === 1,
    data.click_tracking ?? domain.click_tracking === 1,
    domain.id,
  );
  return c.json({ object: 'domain', id: domain.id });
});

domains.post('/:id/verify', async (c) => {
  const domain = await verifyDomain(findDomain(c.req.param('id')));
  return c.json({ object: 'domain', id: domain.id });
});

domains.delete('/:id', async (c) => {
  const domain = findDomain(c.req.param('id'));
  await removeDomain(domain);
  return c.json({ object: 'domain', id: domain.id, deleted: true });
});

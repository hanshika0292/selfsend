import { Hono } from 'hono';
import { z } from 'zod';
import { one, run } from '../db.ts';
import { notFound } from '../errors.ts';
import type { ApiKeyRow } from '../models.ts';
import { generateApiKey, now, sha256, uuidv7 } from '../util.ts';
import { paginate, parseWith, readJson, type ApiEnv } from './shared.ts';

const createSchema = z.object({
  name: z.string().min(1).max(50),
  permission: z.enum(['full_access', 'sending_access']).nullish(),
  domain_id: z.string().nullish(),
});

export function createApiKey(input: z.input<typeof createSchema>): { id: string; token: string } {
  const data = parseWith(createSchema, input);
  if (data.domain_id && !one('SELECT 1 FROM domains WHERE id = ?', data.domain_id)) throw notFound('Domain');
  const id = uuidv7();
  const token = generateApiKey();
  run(
    'INSERT INTO api_keys (id, name, token_hash, token_prefix, permission, domain_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    data.name,
    sha256(token),
    token.slice(0, 10),
    data.permission ?? 'full_access',
    data.domain_id ?? null,
    now(),
  );
  return { id, token };
}

export function revokeApiKey(id: string): void {
  if (run('DELETE FROM api_keys WHERE id = ?', id) === 0) throw notFound('API key');
}

export const apiKeys = new Hono<ApiEnv>();

apiKeys.post('/', async (c) => c.json(createApiKey((await readJson(c)) as z.input<typeof createSchema>)));

apiKeys.get('/', (c) => {
  const page = paginate<ApiKeyRow>(c, 'api_keys');
  return c.json({
    ...page,
    data: page.data.map((k) => ({ id: k.id, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at })),
  });
});

apiKeys.delete('/:id', (c) => {
  revokeApiKey(c.req.param('id'));
  return c.json({ object: 'api_key', id: c.req.param('id'), deleted: true });
});

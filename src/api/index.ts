import { Hono, type Context, type Next } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { one, run } from '../db.ts';
import { ApiError } from '../errors.ts';
import type { ApiKeyRow } from '../models.ts';
import { now, sha256 } from '../util.ts';
import { apiKeys } from './api-keys.ts';
import { broadcasts } from './broadcasts.ts';
import { audiences, contacts, segments } from './contacts.ts';
import { domains } from './domains.ts';
import { emails } from './emails.ts';
import type { ApiEnv } from './shared.ts';
import { suppressions } from './suppressions.ts';
import { webhooks } from './webhooks.ts';

const RESOURCES = {
  '/emails': emails,
  '/domains': domains,
  '/api-keys': apiKeys,
  '/contacts': contacts,
  '/segments': segments,
  '/audiences': audiences,
  '/broadcasts': broadcasts,
  '/webhooks': webhooks,
  '/suppressions': suppressions,
} as const;

export const API_PREFIXES = Object.keys(RESOURCES);

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const SENDING_PATHS = new Set(['/emails', '/emails/batch']);

async function authenticate(c: Context<ApiEnv>, next: Next) {
  const header = c.req.header('Authorization');
  if (!header) {
    throw new ApiError(401, 'missing_api_key', 'Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY');
  }
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const apiKey = one<ApiKeyRow>('SELECT * FROM api_keys WHERE token_hash = ?', sha256(token));
  if (!apiKey) throw new ApiError(403, 'invalid_api_key', 'API key is invalid');
  if (apiKey.permission === 'sending_access' && !(c.req.method === 'POST' && SENDING_PATHS.has(c.req.path))) {
    throw new ApiError(401, 'restricted_api_key', 'This API key is restricted to only send emails');
  }
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), apiKey.id);
  c.set('apiKey', apiKey);
  await next();
}

type IdempotencyRow = { request_hash: string; status_code: number | null; response: string | null };

/** Replays the stored response for a repeated `Idempotency-Key` (24h window, per API key). */
async function idempotency(c: Context<ApiEnv>, next: Next) {
  const key = c.req.header('Idempotency-Key');
  if (!key || c.req.method !== 'POST') return next();
  if (key.length > 256) throw new ApiError(400, 'invalid_idempotency_key', 'The key must be between 1-256 chars.');

  const apiKeyId = c.get('apiKey').id;
  const requestHash = sha256(`${c.req.path}\n${await c.req.text()}`);
  const existing = one<IdempotencyRow>('SELECT * FROM idempotency_keys WHERE api_key_id = ? AND key = ?', apiKeyId, key);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(409, 'invalid_idempotent_request', 'Same idempotency key used with a different request payload. Change your idempotency key or payload.');
    }
    if (existing.response === null) {
      throw new ApiError(409, 'concurrent_idempotent_requests', 'Same idempotency key used while original request is still in progress. Try the request again later.');
    }
    return c.newResponse(existing.response, (existing.status_code ?? 200) as ContentfulStatusCode, { 'content-type': 'application/json' });
  }

  run('INSERT INTO idempotency_keys (api_key_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)', apiKeyId, key, requestHash, now());
  await next();
  if (c.res.ok) {
    run(
      'UPDATE idempotency_keys SET status_code = ?, response = ? WHERE api_key_id = ? AND key = ?',
      c.res.status,
      await c.res.clone().text(),
      apiKeyId,
      key,
    );
  } else {
    run('DELETE FROM idempotency_keys WHERE api_key_id = ? AND key = ?', apiKeyId, key);
  }
}

export const api = new Hono<ApiEnv>();

for (const prefix of API_PREFIXES) {
  api.use(prefix, authenticate);
  api.use(`${prefix}/*`, authenticate);
}
api.use('/emails', idempotency);
api.use('/emails/batch', idempotency);

for (const [prefix, router] of Object.entries(RESOURCES)) api.route(prefix, router);

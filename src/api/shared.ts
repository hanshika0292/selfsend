import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, one } from '../db.ts';
import { ApiError, validation } from '../errors.ts';
import { SENDABLE_STATUSES } from '../mail/domains.ts';
import type { ApiKeyRow, DomainRow } from '../models.ts';
import { addressDomain, bareAddress } from '../util.ts';

export type ApiEnv = { Variables: { apiKey: ApiKeyRow } };

export const address = z.string().refine((value) => bareAddress(value) !== null, {
  message: 'The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.',
});
export const addressList = z.union([address, z.array(address)]);

function describe(issue: z.core.$ZodIssue): string {
  const field = issue.path.join('.') || 'body';
  if (issue.code === 'invalid_type' && issue.message.includes('received undefined')) return `Missing \`${field}\` field.`;
  return `Invalid \`${field}\` field. ${issue.message}`;
}

export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw validation(describe(result.error.issues[0]));
  return result.data;
}

export async function readJson(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw validation('Invalid JSON body.');
  }
}

/**
 * Cursor pagination matching Resend's `limit` / `after` / `before` contract.
 * Ids are UUIDv7, so ordering by id is ordering by creation time.
 */
export function paginate<T extends { id: string }>(c: Context, from: string, where = '1 = 1', params: (string | number)[] = []) {
  const limit = Number(c.req.query('limit') ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validation('The `limit` parameter must be an integer between 1 and 100.');
  const after = c.req.query('after');
  const before = c.req.query('before');
  if (after && before) throw validation('You can only use `after` or `before`, not both.');

  let clause = where;
  const args = [...params];
  let order = 'DESC';
  if (after) {
    clause += ' AND id < ?';
    args.push(after);
  } else if (before) {
    clause += ' AND id > ?';
    args.push(before);
    order = 'ASC';
  }
  const rows = all<T>(`SELECT * FROM ${from} WHERE ${clause} ORDER BY id ${order} LIMIT ?`, ...args, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (before) page.reverse();
  return { object: 'list' as const, has_more: hasMore, data: page };
}

/** Enforces Resend's rule that `from` must use a verified domain (and the key's domain, if the key is scoped). */
export function assertSendableFrom(from: string, apiKey: ApiKeyRow | null): void {
  const domainName = addressDomain(from);
  if (!domainName) throw validation('Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.');
  const domain = one<DomainRow>('SELECT * FROM domains WHERE name = ?', domainName);
  if (apiKey?.domain_id && domain?.id !== apiKey.domain_id) {
    throw new ApiError(403, 'invalid_access', `This API key can only send from the domain it is restricted to.`);
  }
  if (!config.requireVerifiedDomain) return;
  if (!domain || !SENDABLE_STATUSES.has(domain.status)) {
    throw new ApiError(
      403,
      'validation_error',
      `The ${domainName} domain is not verified. Please add and verify your domain at ${config.publicUrl}/dashboard/domains`,
    );
  }
}

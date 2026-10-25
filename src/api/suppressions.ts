import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run } from '../db.ts';
import { notFound, validation } from '../errors.ts';
import { addSuppression } from '../events.ts';
import { bareAddress } from '../util.ts';
import { parseWith, readJson, type ApiEnv } from './shared.ts';

type SuppressionRow = { email: string; reason: string; created_at: string };

// The suppressed address doubles as the suppression id.
const serialize = (row: SuppressionRow) => ({
  object: 'suppression' as const,
  id: row.email,
  email: row.email,
  origin: row.reason,
  created_at: row.created_at,
});

function normalize(value: string): string {
  const email = bareAddress(value);
  if (!email) throw validation('Invalid `email` field.');
  return email;
}

export const suppressions = new Hono<ApiEnv>();

suppressions.post('/', async (c) => {
  const { email } = parseWith(z.object({ email: z.string() }), await readJson(c));
  const address = normalize(email);
  addSuppression(address, 'manual');
  return c.json({ object: 'suppression', id: address });
});

suppressions.post('/batch/add', async (c) => {
  const { emails } = parseWith(z.object({ emails: z.array(z.string()).min(1).max(1000) }), await readJson(c));
  const data = emails.map((value) => {
    const address = normalize(value);
    addSuppression(address, 'manual');
    return { object: 'suppression' as const, id: address };
  });
  return c.json({ data });
});

suppressions.get('/', (c) => {
  const rows = all<SuppressionRow>('SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 101');
  return c.json({ object: 'list', has_more: rows.length > 100, data: rows.slice(0, 100).map(serialize) });
});

suppressions.get('/:email', (c) => {
  const row = one<SuppressionRow>('SELECT * FROM suppressions WHERE email = ?', c.req.param('email').toLowerCase());
  if (!row) throw notFound('Suppression');
  return c.json(serialize(row));
});

suppressions.delete('/:email', (c) => {
  const email = c.req.param('email').toLowerCase();
  if (run('DELETE FROM suppressions WHERE email = ?', email) === 0) throw notFound('Suppression');
  return c.json({ object: 'suppression', id: email, deleted: true });
});

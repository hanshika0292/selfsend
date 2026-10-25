import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { one, run, tx } from '../db.ts';
import { notFound, validation } from '../errors.ts';
import { dispatchWebhookEvent } from '../events.ts';
import { serializeContact, type ContactRow, type SegmentRow } from '../models.ts';
import { bareAddress, now, parseJson, uuidv7 } from '../util.ts';
import { paginate, parseWith, readJson, type ApiEnv } from './shared.ts';

const properties = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const createSchema = z.object({
  email: z.string().refine((v) => bareAddress(v) !== null, 'Enter a valid email address.'),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  unsubscribed: z.boolean().nullish(),
  properties: properties.nullish(),
  segments: z.array(z.object({ id: z.string() })).nullish(),
  topics: z.unknown().optional(),
});

const updateSchema = z.object({
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  unsubscribed: z.boolean().nullish(),
  properties: properties.nullish(),
});

export type ContactInput = z.input<typeof createSchema>;

export function findContact(idOrEmail: string): ContactRow {
  const contact = idOrEmail.includes('@')
    ? one<ContactRow>('SELECT * FROM contacts WHERE email = ?', idOrEmail.toLowerCase())
    : one<ContactRow>('SELECT * FROM contacts WHERE id = ?', idOrEmail);
  if (!contact) throw notFound('Contact');
  return contact;
}

export function findSegment(id: string): SegmentRow {
  const segment = one<SegmentRow>('SELECT * FROM segments WHERE id = ?', id);
  if (!segment) throw notFound('Segment');
  return segment;
}

/** Creates the contact, or updates it if the email already exists, then adds it to the given segments. */
export function upsertContact(input: ContactInput, segmentIds: string[] = []): ContactRow {
  const data = parseWith(createSchema, input);
  const email = bareAddress(data.email) as string;
  const allSegments = [...segmentIds, ...(data.segments ?? []).map((s) => s.id)];
  for (const id of allSegments) findSegment(id);

  const existing = one<ContactRow>('SELECT * FROM contacts WHERE email = ?', email);
  const contact = tx(() => {
    let id: string;
    if (existing) {
      id = existing.id;
      run(
        'UPDATE contacts SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), unsubscribed = COALESCE(?, unsubscribed), properties = ? WHERE id = ?',
        data.first_name ?? null,
        data.last_name ?? null,
        data.unsubscribed ?? null,
        JSON.stringify({ ...parseJson<Record<string, unknown>>(existing.properties, {}), ...(data.properties ?? {}) }),
        id,
      );
    } else {
      id = uuidv7();
      run(
        'INSERT INTO contacts (id, email, first_name, last_name, unsubscribed, properties, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        email,
        data.first_name ?? null,
        data.last_name ?? null,
        data.unsubscribed ?? false,
        JSON.stringify(data.properties ?? {}),
        now(),
      );
    }
    for (const segmentId of allSegments) {
      run('INSERT OR IGNORE INTO contact_segments (contact_id, segment_id) VALUES (?, ?)', id, segmentId);
    }
    return findContact(id);
  });
  dispatchWebhookEvent(existing ? 'contact.updated' : 'contact.created', serializeContact(contact));
  return contact;
}

export function updateContact(contact: ContactRow, input: unknown): ContactRow {
  const data = parseWith(updateSchema, input);
  run(
    'UPDATE contacts SET first_name = ?, last_name = ?, unsubscribed = ?, properties = ? WHERE id = ?',
    data.first_name === undefined ? contact.first_name : data.first_name,
    data.last_name === undefined ? contact.last_name : data.last_name,
    data.unsubscribed ?? contact.unsubscribed === 1,
    JSON.stringify({ ...parseJson<Record<string, unknown>>(contact.properties, {}), ...(data.properties ?? {}) }),
    contact.id,
  );
  const updated = findContact(contact.id);
  dispatchWebhookEvent('contact.updated', serializeContact(updated));
  return updated;
}

export function deleteContact(contact: ContactRow): void {
  run('DELETE FROM contacts WHERE id = ?', contact.id);
  dispatchWebhookEvent('contact.deleted', { id: contact.id, email: contact.email });
}

export function createSegment(name: string): SegmentRow {
  if (!name.trim()) throw validation('Missing `name` field.');
  const id = uuidv7();
  run('INSERT INTO segments (id, name, created_at) VALUES (?, ?, ?)', id, name.trim(), now());
  return findSegment(id);
}

const listContacts = (c: Context, segmentId?: string) => {
  const page = segmentId
    ? paginate<ContactRow>(c, 'contacts', 'id IN (SELECT contact_id FROM contact_segments WHERE segment_id = ?)', [segmentId])
    : paginate<ContactRow>(c, 'contacts');
  return { ...page, data: page.data.map(serializeContact) };
};

// --------------------------------------------------------------- /contacts

export const contacts = new Hono<ApiEnv>();

contacts.post('/', async (c) => c.json({ object: 'contact', id: upsertContact((await readJson(c)) as ContactInput).id }));
contacts.get('/', (c) => c.json(listContacts(c)));
contacts.get('/:idOrEmail', (c) => c.json(serializeContact(findContact(c.req.param('idOrEmail')))));
contacts.patch('/:idOrEmail', async (c) => {
  const contact = updateContact(findContact(c.req.param('idOrEmail')), await readJson(c));
  return c.json({ object: 'contact', id: contact.id });
});
contacts.delete('/:idOrEmail', (c) => {
  const contact = findContact(c.req.param('idOrEmail'));
  deleteContact(contact);
  return c.json({ object: 'contact', contact: contact.id, deleted: true });
});

contacts.get('/:idOrEmail/segments', (c) => {
  const contact = findContact(c.req.param('idOrEmail'));
  const page = paginate<SegmentRow>(c, 'segments', 'id IN (SELECT segment_id FROM contact_segments WHERE contact_id = ?)', [contact.id]);
  return c.json({ ...page, data: page.data.map((s) => ({ id: s.id, name: s.name, created_at: s.created_at })) });
});
contacts.post('/:idOrEmail/segments/:segmentId', (c) => {
  const contact = findContact(c.req.param('idOrEmail'));
  const segment = findSegment(c.req.param('segmentId'));
  run('INSERT OR IGNORE INTO contact_segments (contact_id, segment_id) VALUES (?, ?)', contact.id, segment.id);
  return c.json({ id: segment.id });
});
contacts.delete('/:idOrEmail/segments/:segmentId', (c) => {
  const contact = findContact(c.req.param('idOrEmail'));
  run('DELETE FROM contact_segments WHERE contact_id = ? AND segment_id = ?', contact.id, c.req.param('segmentId'));
  return c.json({ id: c.req.param('segmentId'), deleted: true });
});

// --------------------------------------------------------------- /segments

export const segments = new Hono<ApiEnv>();

segments.post('/', async (c) => {
  const { name } = parseWith(z.object({ name: z.string() }), await readJson(c));
  const segment = createSegment(name);
  return c.json({ object: 'segment', id: segment.id, name: segment.name });
});
segments.get('/', (c) => {
  const page = paginate<SegmentRow>(c, 'segments');
  return c.json({ ...page, data: page.data.map((s) => ({ id: s.id, name: s.name, created_at: s.created_at })) });
});
segments.get('/:id', (c) => {
  const segment = findSegment(c.req.param('id'));
  return c.json({ object: 'segment', id: segment.id, name: segment.name, created_at: segment.created_at });
});
segments.patch('/:id', async (c) => {
  const segment = findSegment(c.req.param('id'));
  const { name } = parseWith(z.object({ name: z.string().min(1) }), await readJson(c));
  run('UPDATE segments SET name = ? WHERE id = ?', name, segment.id);
  return c.json({ object: 'segment', id: segment.id });
});
segments.delete('/:id', (c) => {
  const segment = findSegment(c.req.param('id'));
  run('DELETE FROM segments WHERE id = ?', segment.id);
  return c.json({ object: 'segment', id: segment.id, deleted: true });
});
segments.get('/:id/contacts', (c) => c.json(listContacts(c, findSegment(c.req.param('id')).id)));

// ------------------------------------- /audiences/:id/contacts (legacy SDK paths)

export const audiences = new Hono<ApiEnv>();

audiences.post('/:audienceId/contacts', async (c) => {
  const contact = upsertContact((await readJson(c)) as ContactInput, [c.req.param('audienceId')]);
  return c.json({ object: 'contact', id: contact.id });
});
audiences.get('/:audienceId/contacts', (c) => c.json(listContacts(c, findSegment(c.req.param('audienceId')).id)));
audiences.get('/:audienceId/contacts/:idOrEmail', (c) => c.json(serializeContact(findContact(c.req.param('idOrEmail')))));
audiences.patch('/:audienceId/contacts/:idOrEmail', async (c) => {
  const contact = updateContact(findContact(c.req.param('idOrEmail')), await readJson(c));
  return c.json({ object: 'contact', id: contact.id });
});
audiences.delete('/:audienceId/contacts/:idOrEmail', (c) => {
  const contact = findContact(c.req.param('idOrEmail'));
  deleteContact(contact);
  return c.json({ object: 'contact', contact: contact.id, deleted: true });
});

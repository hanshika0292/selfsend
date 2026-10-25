import { Hono } from 'hono';
import { html } from 'hono/html';
import { createSegment, deleteContact, findContact, upsertContact } from '../api/contacts.ts';
import { all, one, run } from '../db.ts';
import { addSuppression } from '../events.ts';
import type { ContactRow, SegmentRow } from '../models.ts';
import { bareAddress } from '../util.ts';
import { action, list, offsetParam, parseCsv, render, str } from './helpers.ts';
import { empty, pill, time } from './layout.ts';

const PAGE_SIZE = 100;
const MAX_IMPORT_ROWS = 50_000;

export const audiencePages = new Hono();

audiencePages.get('/contacts', (c) => {
  const segmentId = c.req.query('segment') ?? '';
  const q = (c.req.query('q') ?? '').trim();
  const page = offsetParam(c);
  const segments = all<SegmentRow & { n: number }>(
    'SELECT s.*, (SELECT COUNT(*) FROM contact_segments cs WHERE cs.segment_id = s.id) AS n FROM segments s ORDER BY s.name',
  );
  const total = one<{ n: number }>('SELECT COUNT(*) n FROM contacts')?.n ?? 0;
  const where: string[] = [];
  const params: string[] = [];
  if (segmentId) {
    where.push('id IN (SELECT contact_id FROM contact_segments WHERE segment_id = ?)');
    params.push(segmentId);
  }
  if (q) {
    where.push('(email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all<ContactRow>(
    `SELECT * FROM contacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    PAGE_SIZE + 1,
    (page - 1) * PAGE_SIZE,
  );
  const qs = (p: number) => `?${new URLSearchParams({ segment: segmentId, q, page: String(p) })}`;
  const segmentOptions = segments.map((s) => html`<option value="${s.id}" ${s.id === segmentId ? 'selected' : ''}>${s.name}</option>`);

  return render(
    c,
    'Contacts',
    html`<h1>Contacts</h1><p class="sub">Your audience for broadcasts, organised into segments.</p>
    <div class="split">
      <div>
        <div class="card seglist">
          <a href="/dashboard/contacts" class="${segmentId ? '' : 'on'}"><span>All contacts</span><span>${total}</span></a>
          ${segments.map((s) => html`<a href="/dashboard/contacts?segment=${s.id}" class="${s.id === segmentId ? 'on' : ''}"><span>${s.name}</span><span>${s.n}</span></a>`)}
        </div>
        <div class="card"><h2>New segment</h2>
          <form method="post" action="/dashboard/segments"><div class="field"><input name="name" required placeholder="Newsletter"></div><button class="ghost" type="submit">Create</button></form>
        </div>
      </div>
      <div>
        <div class="card">
          <form class="row" method="get">
            ${segmentId ? html`<input type="hidden" name="segment" value="${segmentId}">` : ''}
            <input name="q" value="${q}" placeholder="Search contacts" style="flex:1;min-width:200px"><button class="ghost" type="submit">Search</button>
          </form>
        </div>
        <div class="card">
          ${rows.length === 0
            ? empty('No contacts here yet. Add one below or import a CSV.')
            : html`<div class="table-wrap"><table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Added</th><th></th></tr></thead>
              <tbody>${rows.slice(0, PAGE_SIZE).map(
                (ct) => html`<tr><td>${ct.email}</td><td>${[ct.first_name, ct.last_name].filter(Boolean).join(' ')}</td>
                  <td>${pill(ct.unsubscribed ? 'unsubscribed' : 'subscribed')}</td><td class="muted">${time(ct.created_at)}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <form class="inline" method="post" action="/dashboard/contacts/${ct.id}/toggle"><button class="ghost small">${ct.unsubscribed ? 'Resubscribe' : 'Unsubscribe'}</button></form>
                    <form class="inline" method="post" action="/dashboard/contacts/${ct.id}/delete"><button class="danger small">Delete</button></form>
                  </td></tr>`,
              )}</tbody></table></div>
              <div class="pager">
                ${page > 1 ? html`<a class="btn ghost small" href="${qs(page - 1)}">Previous</a>` : ''}
                ${rows.length > PAGE_SIZE ? html`<a class="btn ghost small" href="${qs(page + 1)}">Next</a>` : ''}
              </div>`}
        </div>
        <div class="grid g2">
          <div class="card"><h2>Add contact</h2>
            <form method="post" action="/dashboard/contacts">
              <div class="field"><label>Email</label><input name="email" type="email" required></div>
              <div class="grid g2"><div class="field"><label>First name</label><input name="first_name"></div><div class="field"><label>Last name</label><input name="last_name"></div></div>
              <div class="field"><label>Segment</label><select name="segment_id"><option value="">None</option>${segmentOptions}</select></div>
              <button type="submit">Add</button>
            </form>
          </div>
          <div class="card"><h2>Import CSV</h2>
            <form method="post" action="/dashboard/contacts/import" enctype="multipart/form-data">
              <div class="field"><label>File with columns email, first_name, last_name (header row optional; extra columns become properties)</label><input type="file" name="file" accept=".csv,text/csv"></div>
              <div class="field"><label>…or paste rows</label><textarea name="csv" style="min-height:90px" placeholder="email,first_name,last_name&#10;ada@example.com,Ada,Lovelace"></textarea></div>
              <div class="field"><label>Add to segment</label><select name="segment_id"><option value="">None</option>${segmentOptions}</select></div>
              <button type="submit">Import</button>
            </form>
          </div>
        </div>
      </div>
    </div>`,
  );
});

audiencePages.post('/segments', (c) =>
  action(c, '/dashboard/contacts', (form) => {
    const segment = createSegment(str(form, 'name'));
    return { to: `/dashboard/contacts?segment=${segment.id}`, ok: `Segment "${segment.name}" created` };
  }),
);

audiencePages.post('/contacts', (c) =>
  action(c, '/dashboard/contacts', (form) => {
    const segmentId = str(form, 'segment_id');
    const contact = upsertContact(
      { email: str(form, 'email'), first_name: str(form, 'first_name') || null, last_name: str(form, 'last_name') || null },
      segmentId ? [segmentId] : [],
    );
    return { to: `/dashboard/contacts${segmentId ? `?segment=${segmentId}` : ''}`, ok: `${contact.email} saved` };
  }),
);

audiencePages.post('/contacts/import', (c) =>
  action(c, '/dashboard/contacts', async (form) => {
    const file = form.file;
    const upload = file instanceof File && file.size > 0 ? await file.text() : '';
    const rows = parseCsv(upload || str(form, 'csv'));
    if (rows.length === 0) throw new Error('Nothing to import.');
    if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import at most ${MAX_IMPORT_ROWS} rows at a time.`);

    const header = rows[0].map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
    const hasHeader = header.includes('email');
    const columns = hasHeader ? header : ['email', 'first_name', 'last_name'];
    const segmentId = str(form, 'segment_id');
    let imported = 0;
    let skipped = 0;
    for (const row of hasHeader ? rows.slice(1) : rows) {
      const record = Object.fromEntries(columns.map((col, i) => [col, row[i] ?? '']));
      if (!bareAddress(record.email ?? '')) {
        skipped++;
        continue;
      }
      const { email, first_name, last_name, ...rest } = record;
      const properties = Object.fromEntries(Object.entries(rest).filter(([k, v]) => k && v));
      upsertContact({ email, first_name: first_name || null, last_name: last_name || null, properties }, segmentId ? [segmentId] : []);
      imported++;
    }
    return {
      to: `/dashboard/contacts${segmentId ? `?segment=${segmentId}` : ''}`,
      ok: `Imported ${imported} contacts${skipped ? `, skipped ${skipped} invalid rows` : ''}`,
    };
  }),
);

audiencePages.post('/contacts/:id/toggle', (c) =>
  action(c, '/dashboard/contacts', () => {
    const contact = findContact(c.req.param('id'));
    run('UPDATE contacts SET unsubscribed = ? WHERE id = ?', contact.unsubscribed ? 0 : 1, contact.id);
    return { ok: `${contact.email} ${contact.unsubscribed ? 'resubscribed' : 'unsubscribed'}` };
  }),
);

audiencePages.post('/contacts/:id/delete', (c) =>
  action(c, '/dashboard/contacts', () => {
    const contact = findContact(c.req.param('id'));
    deleteContact(contact);
    return { ok: `${contact.email} deleted` };
  }),
);

// ------------------------------------------------------------ suppressions

audiencePages.get('/suppressions', (c) => {
  const rows = all<{ email: string; reason: string; created_at: string }>('SELECT * FROM suppressions ORDER BY created_at DESC LIMIT 500');
  return render(
    c,
    'Suppressions',
    html`<h1>Suppressions</h1>
    <p class="sub">Addresses that are never emailed. Hard bounces and spam complaints are added automatically to protect your sender reputation.</p>
    <div class="card"><form class="row" method="post" action="/dashboard/suppressions">
      <input name="email" type="email" required placeholder="someone@example.com" style="flex:1;min-width:220px"><button type="submit">Suppress</button>
    </form></div>
    <div class="card">${rows.length === 0
      ? empty('No suppressed addresses.')
      : html`<div class="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows.map(
          (r) => html`<tr><td>${r.email}</td><td>${pill(r.reason === 'bounce' ? 'bounced' : r.reason === 'complaint' ? 'complained' : r.reason)}</td>
            <td class="muted">${time(r.created_at)}</td>
            <td style="text-align:right"><form class="inline" method="post" action="/dashboard/suppressions/remove">
              <input type="hidden" name="email" value="${r.email}"><button class="ghost small">Remove</button></form></td></tr>`,
        )}</tbody></table></div>`}</div>`,
  );
});

audiencePages.post('/suppressions', (c) =>
  action(c, '/dashboard/suppressions', (form) => {
    const email = bareAddress(str(form, 'email'));
    if (!email) throw new Error('Enter a valid email address.');
    addSuppression(email, 'manual');
    return { ok: `${email} suppressed` };
  }),
);

audiencePages.post('/suppressions/remove', (c) =>
  action(c, '/dashboard/suppressions', (form) => {
    const emails = list(form, 'email');
    for (const email of emails) run('DELETE FROM suppressions WHERE email = ?', email.toLowerCase());
    return { ok: `Removed ${emails.join(', ')}` };
  }),
);

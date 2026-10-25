import { Hono } from 'hono';
import { html } from 'hono/html';
import { assertSendableFrom } from '../api/shared.ts';
import { createBroadcast, findBroadcast, sendBroadcast, updateBroadcast } from '../api/broadcasts.ts';
import { all, one, run } from '../db.ts';
import { recordEmailEvent } from '../events.ts';
import { broadcastHtml, broadcastText, personalize, unsubscribeUrl } from '../mail/compose.ts';
import { enqueueEmail } from '../mail/queue.ts';
import type { BroadcastRow, ContactRow, EmailRow, SegmentRow } from '../models.ts';
import { bareAddress, now, parseJson } from '../util.ts';
import { wakeWorker } from '../worker.ts';
import { action, offsetParam, render, str } from './helpers.ts';
import { empty, percent, pill, time, type Html } from './layout.ts';

const PAGE_SIZE = 50;
const STATUSES = ['queued', 'scheduled', 'sent', 'delivered', 'opened', 'clicked', 'delivery_delayed', 'bounced', 'complained', 'failed', 'suppressed', 'canceled'];

export const mailPages = new Hono();

// ------------------------------------------------------------------ emails

mailPages.get('/emails', (c) => {
  const status = c.req.query('status') ?? '';
  const q = (c.req.query('q') ?? '').trim();
  const page = offsetParam(c);
  const where: string[] = [];
  const params: string[] = [];
  if (STATUSES.includes(status)) {
    where.push('last_event = ?');
    params.push(status);
  }
  if (q) {
    where.push('(to_addrs LIKE ? OR subject LIKE ? OR id = ?)');
    params.push(`%${q}%`, `%${q}%`, q);
  }
  const rows = all<EmailRow>(
    `SELECT * FROM emails ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    PAGE_SIZE + 1,
    (page - 1) * PAGE_SIZE,
  );
  const qs = (p: number) => `?${new URLSearchParams({ status, q, page: String(p) })}`;

  return render(
    c,
    'Emails',
    html`<div class="row between"><div><h1>Emails</h1><p class="sub">Every message sent through the API, dashboard or broadcasts.</p></div></div>
    <div class="card">
      <form class="row" method="get">
        <input name="q" value="${q}" placeholder="Search recipient, subject or id" style="flex:1;min-width:200px">
        <select name="status" style="width:auto"><option value="">All statuses</option>
          ${STATUSES.map((s) => html`<option value="${s}" ${s === status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`)}
        </select>
        <button class="ghost" type="submit">Filter</button>
      </form>
    </div>
    <div class="card">
      ${rows.length === 0
        ? empty('No emails yet. Send one with the API or the form below.')
        : html`<div class="table-wrap"><table>
          <thead><tr><th>To</th><th>Subject</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>${rows.slice(0, PAGE_SIZE).map(
            (e) => html`<tr>
              <td><a href="/dashboard/emails/${e.id}">${parseJson<string[]>(e.to_addrs, []).join(', ')}</a></td>
              <td>${e.subject}${e.broadcast_id ? html` <span class="faint">· broadcast</span>` : ''}</td>
              <td>${pill(e.last_event)}</td>
              <td class="muted">${time(e.created_at)}</td>
            </tr>`,
          )}</tbody></table></div>
          <div class="pager">
            ${page > 1 ? html`<a class="btn ghost small" href="${qs(page - 1)}">Newer</a>` : ''}
            ${rows.length > PAGE_SIZE ? html`<a class="btn ghost small" href="${qs(page + 1)}">Older</a>` : ''}
          </div>`}
    </div>
    <div class="card">
      <h2>Send a test email</h2>
      <form method="post" action="/dashboard/emails/send">
        <div class="grid g3">
          <div class="field"><label>From</label><input name="from" required placeholder="You <hello@yourdomain.com>"></div>
          <div class="field"><label>To</label><input name="to" required placeholder="you@example.com"></div>
          <div class="field"><label>Subject</label><input name="subject" required value="Hello from SelfSend"></div>
        </div>
        <div class="field"><label>HTML</label><textarea name="html" required><p>It works! 🎉</p></textarea></div>
        <button type="submit">Send</button>
      </form>
    </div>`,
  );
});

mailPages.post('/emails/send', (c) =>
  action(c, '/dashboard/emails', (form) => {
    const from = str(form, 'from');
    const to = str(form, 'to');
    if (!bareAddress(to)) throw new Error('Enter a valid recipient address.');
    assertSendableFrom(from, null);
    const id = enqueueEmail({ from, to: [to], subject: str(form, 'subject'), html: str(form, 'html') });
    wakeWorker();
    return { to: `/dashboard/emails/${id}`, ok: 'Email queued' };
  }),
);

mailPages.get('/emails/:id', (c) => {
  const email = one<EmailRow>('SELECT * FROM emails WHERE id = ?', c.req.param('id'));
  if (!email) return render(c, 'Not found', html`<h1>Email not found</h1>`, 404);
  const events = all<{ type: string; data: string | null; created_at: string }>(
    'SELECT type, data, created_at FROM email_events WHERE email_id = ? ORDER BY created_at, id',
    email.id,
  );
  const meta: [string, Html | string][] = [
    ['From', email.from_addr],
    ['To', parseJson<string[]>(email.to_addrs, []).join(', ')],
    ['Cc', parseJson<string[]>(email.cc, []).join(', ') || '—'],
    ['Bcc', parseJson<string[]>(email.bcc, []).join(', ') || '—'],
    ['Reply-To', parseJson<string[]>(email.reply_to, []).join(', ') || '—'],
    ['Created', time(email.created_at)],
    ['Scheduled', time(email.scheduled_at)],
    ['Sent', time(email.sent_at)],
    ['Message-ID', html`<span class="mono">${email.message_id ?? '—'}</span>`],
    ['ID', html`<span class="mono">${email.id}</span>`],
  ];
  return render(
    c,
    email.subject,
    html`<p class="muted" style="margin:0 0 6px"><a href="/dashboard/emails">← Emails</a></p>
    <div class="row between"><h1>${email.subject}</h1><div class="row">${pill(email.last_event)}
      ${email.status === 'scheduled'
        ? html`<form class="inline" method="post" action="/dashboard/emails/${email.id}/cancel"><button class="danger small">Cancel send</button></form>`
        : ''}</div></div>
    ${email.error ? html`<div class="flash error">${email.error}</div>` : ''}
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>Details</h2><table><tbody>
        ${meta.map(([k, v]) => html`<tr><td class="muted" style="width:110px">${k}</td><td>${v}</td></tr>`)}
      </tbody></table></div>
      <div class="card"><h2>Events</h2>
        ${events.length === 0
          ? empty('No events yet.')
          : html`<ul class="timeline">${events.map(
              (e) => html`<li>${pill(e.type)}<span class="muted">${time(e.created_at)}</span>
                ${e.data ? html`<details><summary>data</summary><pre>${JSON.stringify(JSON.parse(e.data), null, 2)}</pre></details>` : ''}</li>`,
            )}</ul>`}
      </div>
    </div>
    ${email.html ? html`<div class="card"><h2>Preview</h2><iframe class="preview" sandbox srcdoc="${email.html}"></iframe></div>` : ''}
    ${email.text ? html`<div class="card"><h2>Plain text</h2><pre>${email.text}</pre></div>` : ''}`,
  );
});

mailPages.post('/emails/:id/cancel', (c) =>
  action(c, `/dashboard/emails/${c.req.param('id')}`, () => {
    if (run("UPDATE emails SET status = 'canceled' WHERE id = ? AND status = 'scheduled'", c.req.param('id')) === 0) {
      throw new Error('Only scheduled emails can be canceled.');
    }
    recordEmailEvent(c.req.param('id'), 'canceled');
    return { ok: 'Send canceled' };
  }),
);

// -------------------------------------------------------------- broadcasts

type BroadcastStats = { total: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number };

function broadcastStats(id: string): BroadcastStats {
  const total = one<{ n: number }>('SELECT COUNT(*) n FROM emails WHERE broadcast_id = ?', id)?.n ?? 0;
  const count = (type: string) =>
    one<{ n: number }>(
      'SELECT COUNT(DISTINCT ev.email_id) n FROM email_events ev JOIN emails e ON e.id = ev.email_id WHERE e.broadcast_id = ? AND ev.type = ?',
      id,
      type,
    )?.n ?? 0;
  return {
    total,
    delivered: count('delivered'),
    opened: count('opened'),
    clicked: count('clicked'),
    bounced: count('bounced'),
    complained: count('complained'),
  };
}

/** Shows the broadcast as a recipient without a first name would see it: fallbacks applied, footer included. */
function renderedPreview(b: BroadcastRow): Html {
  const sample: ContactRow = { id: 'preview', email: 'recipient@example.com', first_name: null, last_name: null, unsubscribed: 0, properties: '{}', created_at: now() };
  const unsubscribe = '#unsubscribe';
  const subject = personalize(b.subject ?? '', sample, unsubscribe, false);
  return html`<p><strong>${subject}</strong> <span class="muted">from ${b.from_addr}</span></p>
    ${b.html
      ? html`<iframe class="preview" sandbox srcdoc="${personalize(broadcastHtml(b.html, b.preview_text), sample, unsubscribe, true)}"></iframe>`
      : html`<pre>${personalize(broadcastText(b.text ?? ''), sample, unsubscribe, false)}</pre>`}`;
}

function recipientsTable(broadcastId: string): Html {
  const rows = all<EmailRow>('SELECT * FROM emails WHERE broadcast_id = ? ORDER BY id LIMIT 500', broadcastId);
  if (rows.length === 0) return empty('No recipients yet — the broadcast is still being queued.');
  return html`<div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Status</th><th>Sent</th></tr></thead>
    <tbody>${rows.map(
      (e) => html`<tr><td><a href="/dashboard/emails/${e.id}">${parseJson<string[]>(e.to_addrs, []).join(', ')}</a></td>
        <td>${pill(e.last_event)}</td><td class="muted">${time(e.sent_at)}</td></tr>`,
    )}</tbody></table></div>
    ${rows.length === 500 ? html`<p class="faint">Showing the first 500 recipients.</p>` : ''}`;
}

function broadcastForm(b: Partial<BroadcastRow>, segments: SegmentRow[], actionUrl: string): Html {
  return html`<form method="post" action="${actionUrl}">
    <div class="grid g2">
      <div class="field"><label>Name (internal)</label><input name="name" value="${b.name ?? ''}" placeholder="October newsletter"></div>
      <div class="field"><label>Segment</label><select name="segment_id" required>
        <option value="">Choose a segment…</option>
        ${segments.map((s) => html`<option value="${s.id}" ${s.id === b.segment_id ? 'selected' : ''}>${s.name}</option>`)}
      </select></div>
      <div class="field"><label>From</label><input name="from" required value="${b.from_addr ?? ''}" placeholder="Team <news@yourdomain.com>"></div>
      <div class="field"><label>Reply-To (optional)</label><input name="reply_to" value="${parseJson<string[]>(b.reply_to ?? null, []).join(', ')}"></div>
      <div class="field"><label>Subject</label><input name="subject" required value="${b.subject ?? ''}" placeholder="Hi {{{FIRST_NAME|there}}}, this week's update"></div>
      <div class="field"><label>Preview text (optional)</label><input name="preview_text" value="${b.preview_text ?? ''}"></div>
    </div>
    <div class="field"><label>HTML — merge tags: {{{FIRST_NAME|fallback}}}, {{{EMAIL}}}, {{{RESEND_UNSUBSCRIBE_URL}}}. An unsubscribe footer is added if you don't include one.</label>
      <textarea name="html" style="min-height:260px">${b.html ?? '<p>Hi {{{FIRST_NAME|there}}},</p>\n<p>…</p>'}</textarea></div>
    <div class="field"><label>Plain text (optional)</label><textarea name="text">${b.text ?? ''}</textarea></div>
    <button type="submit">Save draft</button>
  </form>`;
}

function broadcastFields(form: Record<string, unknown>) {
  const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
  const replyTo = get('reply_to')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: get('name') || null,
    segment_id: get('segment_id') || null,
    from: get('from') || null,
    reply_to: replyTo.length ? replyTo : null,
    subject: get('subject') || null,
    preview_text: get('preview_text') || null,
    html: get('html') || null,
    text: get('text') || null,
  };
}

mailPages.get('/broadcasts', (c) => {
  const rows = all<BroadcastRow & { recipients: number }>(
    'SELECT b.*, (SELECT COUNT(*) FROM emails e WHERE e.broadcast_id = b.id) AS recipients FROM broadcasts b ORDER BY b.id DESC LIMIT 200',
  );
  const segments = all<SegmentRow>('SELECT * FROM segments ORDER BY name');
  return render(
    c,
    'Broadcasts',
    html`<h1>Broadcasts</h1><p class="sub">Newsletters and announcements to a contact segment, with unsubscribe handling built in.</p>
    <div class="card">${rows.length === 0
      ? empty('No broadcasts yet.')
      : html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Subject</th><th>Status</th><th>Recipients</th><th>Sent / scheduled</th></tr></thead>
        <tbody>${rows.map(
          (b) => html`<tr><td><a href="/dashboard/broadcasts/${b.id}">${b.name || 'Untitled'}</a></td><td>${b.subject ?? ''}</td>
            <td>${pill(b.status === 'queued' && b.scheduled_at ? 'scheduled' : b.status)}</td><td>${b.recipients}</td>
            <td class="muted">${time(b.sent_at ?? b.scheduled_at)}</td></tr>`,
        )}</tbody></table></div>`}
    </div>
    <div class="card"><h2>New broadcast</h2>
      ${segments.length === 0
        ? html`<p class="muted">Create a segment and add contacts on the <a href="/dashboard/contacts">Contacts</a> page first.</p>`
        : broadcastForm({}, segments, '/dashboard/broadcasts')}
    </div>`,
  );
});

mailPages.post('/broadcasts', (c) =>
  action(c, '/dashboard/broadcasts', (form) => {
    const broadcast = createBroadcast(broadcastFields(form), null);
    return { to: `/dashboard/broadcasts/${broadcast.id}`, ok: 'Draft saved' };
  }),
);

mailPages.get('/broadcasts/:id', (c) => {
  const b = one<BroadcastRow>('SELECT * FROM broadcasts WHERE id = ?', c.req.param('id'));
  if (!b) return render(c, 'Not found', html`<h1>Broadcast not found</h1>`, 404);
  const segments = all<SegmentRow>('SELECT * FROM segments ORDER BY name');
  const segment = segments.find((s) => s.id === b.segment_id);
  const audience = b.segment_id
    ? (one<{ n: number }>(
        `SELECT COUNT(*) n FROM contacts c JOIN contact_segments cs ON cs.contact_id = c.id
          WHERE cs.segment_id = ? AND c.unsubscribed = 0 AND c.email NOT IN (SELECT email FROM suppressions)`,
        b.segment_id,
      )?.n ?? 0)
    : 0;
  const stats = broadcastStats(b.id);
  const base = `/dashboard/broadcasts/${b.id}`;

  return render(
    c,
    b.name || 'Broadcast',
    html`<p class="muted" style="margin:0 0 6px"><a href="/dashboard/broadcasts">← Broadcasts</a></p>
    <div class="row between"><h1>${b.name || 'Untitled broadcast'}</h1>${pill(b.status === 'queued' && b.scheduled_at ? 'scheduled' : b.status)}</div>
    <p class="sub">Segment: ${segment?.name ?? '—'} · ${audience} subscribed recipients</p>
    ${b.status === 'draft'
      ? html`<div class="grid g2">
          <div class="card"><h2>Send</h2>
            <form method="post" action="${base}/send" class="row">
              <input name="scheduled_at" placeholder="Leave empty to send now, or: in 2 hours / 2026-10-21T09:00:00Z" style="flex:1;min-width:220px">
              <button type="submit">Send to ${audience}</button>
            </form></div>
          <div class="card"><h2>Send a test</h2>
            <form method="post" action="${base}/test" class="row">
              <input name="to" required placeholder="you@example.com" style="flex:1;min-width:200px">
              <button class="ghost" type="submit">Send test</button>
            </form></div>
        </div>
        <div class="card"><h2>Edit</h2>${broadcastForm(b, segments, base)}</div>
        <form method="post" action="${base}/delete" style="margin-top:16px"><button class="danger small">Delete draft</button></form>`
      : html`<div class="grid g6">
          ${[
            ['Recipients', String(stats.total), ''],
            ['Delivered', percent(stats.delivered, stats.total), String(stats.delivered)],
            ['Opened', percent(stats.opened, stats.delivered || stats.total), String(stats.opened)],
            ['Clicked', percent(stats.clicked, stats.delivered || stats.total), String(stats.clicked)],
            ['Bounced', percent(stats.bounced, stats.total), String(stats.bounced)],
            ['Complained', percent(stats.complained, stats.total), String(stats.complained)],
          ].map(([label, value, hint]) => html`<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`)}
        </div>
        <div class="card"><h2>Content</h2>${renderedPreview(b)}</div>
        <div class="card"><h2>Recipients</h2>${recipientsTable(b.id)}</div>`}`,
  );
});

mailPages.post('/broadcasts/:id', (c) =>
  action(c, `/dashboard/broadcasts/${c.req.param('id')}`, (form) => {
    updateBroadcast(findBroadcast(c.req.param('id')), broadcastFields(form));
    return { ok: 'Draft saved' };
  }),
);

mailPages.post('/broadcasts/:id/send', (c) =>
  action(c, `/dashboard/broadcasts/${c.req.param('id')}`, (form) => {
    const b = sendBroadcast(findBroadcast(c.req.param('id')), str(form, 'scheduled_at') || null, null);
    return { ok: b.scheduled_at && b.scheduled_at > now() ? 'Broadcast scheduled' : 'Broadcast is sending' };
  }),
);

mailPages.post('/broadcasts/:id/test', (c) =>
  action(c, `/dashboard/broadcasts/${c.req.param('id')}`, (form) => {
    const b = findBroadcast(c.req.param('id'));
    const to = bareAddress(str(form, 'to'));
    if (!to) throw new Error('Enter a valid test address.');
    if (!b.from_addr || !b.subject || (!b.html && !b.text)) throw new Error('Fill in from, subject and content first.');
    assertSendableFrom(b.from_addr, null);
    const contact: ContactRow = {
      id: 'test',
      email: to,
      first_name: 'Test',
      last_name: 'Recipient',
      unsubscribed: 0,
      properties: '{}',
      created_at: now(),
    };
    const unsubscribe = unsubscribeUrl(to);
    enqueueEmail({
      from: b.from_addr,
      to: [to],
      subject: `[Test] ${personalize(b.subject, contact, unsubscribe, false)}`,
      html: b.html ? personalize(broadcastHtml(b.html, b.preview_text), contact, unsubscribe, true) : null,
      text: b.text ? personalize(broadcastText(b.text), contact, unsubscribe, false) : null,
    });
    wakeWorker();
    return { ok: `Test sent to ${to}` };
  }),
);

mailPages.post('/broadcasts/:id/delete', (c) =>
  action(c, `/dashboard/broadcasts/${c.req.param('id')}`, () => {
    run("DELETE FROM broadcasts WHERE id = ? AND status = 'draft'", c.req.param('id'));
    return { to: '/dashboard/broadcasts', ok: 'Draft deleted' };
  }),
);

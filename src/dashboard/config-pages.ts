import { Hono } from 'hono';
import { html } from 'hono/html';
import { createApiKey, revokeApiKey } from '../api/api-keys.ts';
import { createDomain, findDomain, removeDomain, verifyDomain } from '../api/domains.ts';
import { WEBHOOK_EVENTS, createWebhook, findWebhook } from '../api/webhooks.ts';
import { config } from '../config.ts';
import { all, run } from '../db.ts';
import type { ApiKeyRow, DomainRecord, DomainRow, WebhookRow } from '../models.ts';
import { parseJson } from '../util.ts';
import { action, list, render, str } from './helpers.ts';
import { empty, pill, time } from './layout.ts';

export const configPages = new Hono();

// ----------------------------------------------------------------- domains

configPages.get('/domains', (c) => {
  const rows = all<DomainRow>('SELECT * FROM domains ORDER BY id DESC');
  return render(
    c,
    'Domains',
    html`<h1>Domains</h1><p class="sub">Verify a domain to send from it. SelfSend creates the SES identity and shows the DNS records to add.</p>
    <div class="card"><form class="row" method="post" action="/dashboard/domains">
      <input name="name" required placeholder="yourdomain.com" style="flex:1;min-width:220px"><button type="submit">Add domain</button>
    </form></div>
    <div class="card">${rows.length === 0
      ? empty('No domains yet.')
      : html`<div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th>Region</th><th>Added</th></tr></thead>
        <tbody>${rows.map(
          (d) => html`<tr><td><a href="/dashboard/domains/${d.id}">${d.name}</a></td><td>${pill(d.status)}</td>
            <td class="muted">${d.region}</td><td class="muted">${time(d.created_at)}</td></tr>`,
        )}</tbody></table></div>`}</div>`,
  );
});

configPages.post('/domains', (c) =>
  action(c, '/dashboard/domains', async (form) => {
    const domain = await createDomain({ name: str(form, 'name') });
    return { to: `/dashboard/domains/${domain.id}`, ok: 'Domain added. Add the DNS records below, then click Verify.' };
  }),
);

configPages.get('/domains/:id', (c) => {
  const d = findDomain(c.req.param('id'));
  const records = parseJson<DomainRecord[]>(d.records, []);
  const base = `/dashboard/domains/${d.id}`;
  return render(
    c,
    d.name,
    html`<p class="muted" style="margin:0 0 6px"><a href="/dashboard/domains">← Domains</a></p>
    <div class="row between"><h1>${d.name}</h1><div class="row">${pill(d.status)}
      <form class="inline" method="post" action="${base}/verify"><button class="small">Verify DNS</button></form></div></div>
    <p class="sub">${config.transport === 'ses'
      ? 'Add these records at your DNS provider. DKIM is required to send; SPF (custom MAIL FROM) and DMARC improve deliverability.'
      : `Transport is "${config.transport}": your SMTP provider handles SPF/DKIM. A DMARC record is still recommended.`}</p>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Priority</th><th>Status</th></tr></thead>
      <tbody>${records.map(
        (r) => html`<tr><td><span class="mono">${r.type}</span> <span class="faint">${r.record}</span></td>
          <td class="mono">${r.name}</td><td class="mono">${r.value}</td><td class="mono">${r.priority ?? ''}</td>
          <td>${pill(r.status)}</td></tr>`,
      )}</tbody></table></div></div>
    <div class="grid g2">
      <div class="card"><h2>Tracking</h2>
        <form method="post" action="${base}/tracking">
          <label class="check"><input type="checkbox" name="open_tracking" ${d.open_tracking ? 'checked' : ''}> Open tracking (invisible pixel)</label>
          <label class="check" style="margin-top:8px"><input type="checkbox" name="click_tracking" ${d.click_tracking ? 'checked' : ''}> Click tracking (link redirects)</label>
          <p class="faint">Apple Mail Privacy Protection pre-loads images, so open rates are inflated; clicks are more reliable.</p>
          <button class="ghost" type="submit">Save</button>
        </form></div>
      <div class="card"><h2>Danger zone</h2><p class="muted">Removing the domain also deletes its SES identity.</p>
        <form method="post" action="${base}/delete"><button class="danger">Remove domain</button></form></div>
    </div>`,
  );
});

configPages.post('/domains/:id/verify', (c) =>
  action(c, `/dashboard/domains/${c.req.param('id')}`, async () => {
    const d = await verifyDomain(findDomain(c.req.param('id')));
    return { ok: `Status: ${d.status.replace(/_/g, ' ')}` };
  }),
);

configPages.post('/domains/:id/tracking', (c) =>
  action(c, `/dashboard/domains/${c.req.param('id')}`, (form) => {
    run('UPDATE domains SET open_tracking = ?, click_tracking = ? WHERE id = ?', 'open_tracking' in form, 'click_tracking' in form, c.req.param('id'));
    return { ok: 'Tracking settings saved' };
  }),
);

configPages.post('/domains/:id/delete', (c) =>
  action(c, `/dashboard/domains/${c.req.param('id')}`, async () => {
    const d = findDomain(c.req.param('id'));
    await removeDomain(d);
    return { to: '/dashboard/domains', ok: `${d.name} removed` };
  }),
);

// ---------------------------------------------------------------- API keys

function apiKeysPage(created?: { name: string; token: string }) {
  const keys = all<ApiKeyRow & { domain: string | null }>(
    'SELECT k.*, d.name AS domain FROM api_keys k LEFT JOIN domains d ON d.id = k.domain_id ORDER BY k.id DESC',
  );
  const domains = all<DomainRow>('SELECT * FROM domains ORDER BY name');
  return html`<h1>API Keys</h1><p class="sub">Use these with the official <span class="mono">resend</span> SDK by setting <span class="mono">RESEND_BASE_URL=${config.publicUrl}</span>.</p>
    ${created
      ? html`<div class="card warn"><h2>Copy your new key "${created.name}" now — it won't be shown again</h2><div class="secret">${created.token}</div></div>`
      : ''}
    <div class="card">${keys.length === 0
      ? empty('No API keys yet.')
      : html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Token</th><th>Permission</th><th>Last used</th><th>Created</th><th></th></tr></thead>
        <tbody>${keys.map(
          (k) => html`<tr><td>${k.name}</td><td class="mono">${k.token_prefix}…</td>
            <td>${k.permission === 'full_access' ? 'Full access' : `Sending${k.domain ? ` · ${k.domain}` : ''}`}</td>
            <td class="muted">${time(k.last_used_at)}</td><td class="muted">${time(k.created_at)}</td>
            <td style="text-align:right"><form class="inline" method="post" action="/dashboard/api-keys/${k.id}/delete"><button class="danger small">Revoke</button></form></td></tr>`,
        )}</tbody></table></div>`}</div>
    <div class="card"><h2>Create API key</h2>
      <form method="post" action="/dashboard/api-keys"><div class="grid g3">
        <div class="field"><label>Name</label><input name="name" required placeholder="Production"></div>
        <div class="field"><label>Permission</label><select name="permission"><option value="full_access">Full access</option><option value="sending_access">Sending access</option></select></div>
        <div class="field"><label>Restrict to domain (sending access)</label><select name="domain_id"><option value="">Any domain</option>
          ${domains.map((d) => html`<option value="${d.id}">${d.name}</option>`)}</select></div>
      </div><button type="submit">Create</button></form>
    </div>`;
}

configPages.get('/api-keys', (c) => render(c, 'API Keys', apiKeysPage()));

// Rendered directly (no redirect) so the token never lands in a URL or browser history.
configPages.post('/api-keys', async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim();
  try {
    const permission = form.permission === 'sending_access' ? 'sending_access' : 'full_access';
    const { token } = createApiKey({
      name,
      permission,
      domain_id: permission === 'sending_access' && form.domain_id ? String(form.domain_id) : null,
    });
    return render(c, 'API Keys', apiKeysPage({ name, token }));
  } catch (err) {
    return c.redirect(`/dashboard/api-keys?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
});

configPages.post('/api-keys/:id/delete', (c) =>
  action(c, '/dashboard/api-keys', () => {
    revokeApiKey(c.req.param('id'));
    return { ok: 'API key revoked' };
  }),
);

// ---------------------------------------------------------------- webhooks

configPages.get('/webhooks', (c) => {
  const hooks = all<WebhookRow>('SELECT * FROM webhooks ORDER BY id DESC');
  return render(
    c,
    'Webhooks',
    html`<h1>Webhooks</h1><p class="sub">Signed with the Standard Webhooks scheme, so <span class="mono">resend.webhooks.verify()</span> and Svix libraries work unchanged.</p>
    <div class="card">${hooks.length === 0
      ? empty('No webhooks yet.')
      : html`<div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>${hooks.map(
          (h) => html`<tr><td><a href="/dashboard/webhooks/${h.id}" class="mono">${h.endpoint}</a></td>
            <td class="muted">${parseJson<string[]>(h.events, []).length} events</td><td>${pill(h.status)}</td><td class="muted">${time(h.created_at)}</td></tr>`,
        )}</tbody></table></div>`}</div>
    <div class="card"><h2>Add endpoint</h2>
      <form method="post" action="/dashboard/webhooks">
        <div class="field"><label>Endpoint URL</label><input name="endpoint" type="url" required placeholder="https://yourapp.com/api/email-events"></div>
        <div class="field"><label>Events</label><div class="grid g3">
          ${WEBHOOK_EVENTS.map((e) => html`<label class="check"><input type="checkbox" name="events" value="${e}" ${e.startsWith('email.') ? 'checked' : ''}> <span class="mono">${e}</span></label>`)}
        </div></div>
        <button type="submit">Add webhook</button>
      </form></div>`,
  );
});

configPages.post('/webhooks', (c) =>
  action(c, '/dashboard/webhooks', (form) => {
    const hook = createWebhook({ endpoint: str(form, 'endpoint'), events: list(form, 'events') as (typeof WEBHOOK_EVENTS)[number][] });
    return { to: `/dashboard/webhooks/${hook.id}`, ok: 'Webhook created' };
  }),
);

configPages.get('/webhooks/:id', (c) => {
  const hook = findWebhook(c.req.param('id'));
  const deliveries = all<{ id: string; event_type: string; status: string; attempts: number; last_status_code: number | null; last_error: string | null; created_at: string }>(
    'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 100',
    hook.id,
  );
  const base = `/dashboard/webhooks/${hook.id}`;
  return render(
    c,
    'Webhook',
    html`<p class="muted" style="margin:0 0 6px"><a href="/dashboard/webhooks">← Webhooks</a></p>
    <div class="row between"><h1 class="mono" style="font-size:17px">${hook.endpoint}</h1>${pill(hook.status)}</div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>Signing secret</h2><div class="secret">${hook.secret}</div></div>
      <div class="card"><h2>Subscribed events</h2><p class="mono" style="margin:0 0 12px">${parseJson<string[]>(hook.events, []).join(', ')}</p>
        <div class="row">
          <form class="inline" method="post" action="${base}/toggle"><button class="ghost small">${hook.status === 'enabled' ? 'Disable' : 'Enable'}</button></form>
          <form class="inline" method="post" action="${base}/delete"><button class="danger small">Delete</button></form>
        </div></div>
    </div>
    <div class="card"><h2>Recent deliveries</h2>${deliveries.length === 0
      ? empty('No deliveries yet.')
      : html`<div class="table-wrap"><table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>Created</th></tr></thead>
        <tbody>${deliveries.map(
          (d) => html`<tr><td class="mono">${d.event_type}</td><td>${pill(d.status === 'delivered' ? 'delivered' : d.status === 'failed' ? 'failed' : 'pending')}</td>
            <td>${d.attempts}</td><td class="muted">${d.last_status_code ?? d.last_error ?? '—'}</td><td class="muted">${time(d.created_at)}</td></tr>`,
        )}</tbody></table></div>`}</div>`,
  );
});

configPages.post('/webhooks/:id/toggle', (c) =>
  action(c, `/dashboard/webhooks/${c.req.param('id')}`, () => {
    const hook = findWebhook(c.req.param('id'));
    run('UPDATE webhooks SET status = ? WHERE id = ?', hook.status === 'enabled' ? 'disabled' : 'enabled', hook.id);
    return { ok: 'Webhook updated' };
  }),
);

configPages.post('/webhooks/:id/delete', (c) =>
  action(c, `/dashboard/webhooks/${c.req.param('id')}`, () => {
    run('DELETE FROM webhooks WHERE id = ?', c.req.param('id'));
    return { to: '/dashboard/webhooks', ok: 'Webhook deleted' };
  }),
);

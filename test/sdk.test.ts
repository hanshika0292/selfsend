// End-to-end: drives a real SelfSend server (log transport) with the official `resend` SDK.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import PostalMime from 'postal-mime';
import { Resend } from 'resend';

process.env.NODE_ENV = 'production'; // the SDK logs every error response outside production; negative tests expect them

const PORT = 4500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'selfsend-test-'));
const env = {
  ...process.env,
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  DATABASE_PATH: join(dir, 'db.sqlite'),
  MAIL_TRANSPORT: 'log',
  ADMIN_PASSWORD: 'test-password',
  NODE_ENV: 'production', // silences the SDK's console error logging
};

let server: ChildProcess;
let receiver: Server;
const received: { body: string; headers: Record<string, string> }[] = [];
let resend: Resend;
let token: string;

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function outbox(emailId: string) {
  const raw = readFileSync(join(dir, 'outbox', `${emailId}.eml`));
  return PostalMime.parse(raw);
}

before(async () => {
  server = spawn(process.execPath, ['src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(() => fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), 'server start');
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'create-key', 'test'], { env, encoding: 'utf8' });
  token = cli.stdout.trim();
  assert.match(token, /^re_/);
  resend = new Resend(token, { baseUrl: BASE });

  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ body, headers: req.headers as Record<string, string> });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
});

after(() => {
  server?.kill();
  receiver?.close();
  rmSync(dir, { recursive: true, force: true });
});

const FROM = 'Example App <hello@example.com>';
let domainId = '';
let webhookSecret = '';

test('rejects missing and invalid API keys', async () => {
  const res = await fetch(`${BASE}/emails`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).name, 'missing_api_key');
  const bad = await new Resend('re_nope', { baseUrl: BASE }).emails.list();
  assert.equal(bad.error?.name, 'invalid_api_key');
});

test('domains: create, block unverified sends, verify, enable tracking', async () => {
  const created = await resend.domains.create({ name: 'example.com' });
  assert.equal(created.error, null);
  domainId = created.data!.id;
  assert.ok(Array.isArray(created.data!.records));

  const blocked = await resend.emails.send({ from: FROM, to: 'a@example.com', subject: 'x', html: '<p>x</p>' });
  assert.equal(blocked.error?.name, 'validation_error');
  assert.match(blocked.error!.message, /not verified/);

  assert.equal((await resend.domains.verify(domainId)).error, null);
  const domain = await resend.domains.get(domainId);
  assert.equal(domain.data?.status, 'verified');

  assert.equal((await resend.domains.update({ id: domainId, openTracking: true, clickTracking: true })).error, null);
  const listed = await resend.domains.list();
  assert.equal(listed.data?.data.length, 1);
});

test('webhooks: create subscription', async () => {
  const address = receiver.address() as { port: number };
  const hook = await resend.webhooks.create({
    endpoint: `http://127.0.0.1:${address.port}/hook`,
    events: ['email.sent', 'email.delivered', 'email.opened', 'email.clicked', 'contact.created'],
  });
  assert.equal(hook.error, null);
  assert.match(hook.data!.signing_secret, /^whsec_/);
  webhookSecret = hook.data!.signing_secret;
});

test('emails: send, track opens and clicks, idempotency', async () => {
  const payload = {
    from: FROM,
    to: ['user@example.com'],
    subject: 'Your booking is confirmed',
    html: '<html><body><p>See you soon.</p><a href="https://example.com/guide?x=1&amp;y=2">Guide</a></body></html>',
    text: 'See you soon.',
    tags: [{ name: 'category', value: 'confirmation' }],
  };
  const first = await resend.emails.send(payload, { idempotencyKey: 'confirm-123' });
  assert.equal(first.error, null);
  const id = first.data!.id;

  const replay = await resend.emails.send(payload, { idempotencyKey: 'confirm-123' });
  assert.equal(replay.data?.id, id, 'same idempotency key returns the original email');
  const conflict = await resend.emails.send({ ...payload, subject: 'different' }, { idempotencyKey: 'confirm-123' });
  assert.equal(conflict.error?.name, 'invalid_idempotent_request');

  await waitFor(async () => (await resend.emails.get(id)).data?.last_event === 'delivered', 'delivery');
  const email = (await resend.emails.get(id)).data!;
  assert.deepEqual(email.to, ['user@example.com']);
  assert.deepEqual(email.tags, [{ name: 'category', value: 'confirmation' }]);

  const mime = await outbox(id);
  const pixel = mime.html!.match(/src="([^"]+\/t\/o\/[^"]+)"/)![1];
  const click = mime.html!.match(/href="([^"]+\/t\/c\/[^"]+)"/)![1];
  assert.equal((await fetch(pixel)).headers.get('content-type'), 'image/gif');
  const redirect = await fetch(click, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/guide?x=1&y=2');
  const tampered = await fetch(click.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), { redirect: 'manual' });
  assert.equal(tampered.status, 400, 'click tokens cannot be forged into an open redirect');
  await waitFor(async () => (await resend.emails.get(id)).data?.last_event === 'clicked', 'click event');
});

test('webhooks: deliveries carry valid Standard Webhooks signatures', async () => {
  await waitFor(async () => received.some((r) => JSON.parse(r.body).type === 'email.clicked'), 'webhook deliveries');
  const types = received.map((r) => JSON.parse(r.body).type);
  for (const type of ['email.sent', 'email.delivered', 'email.opened', 'email.clicked']) assert.ok(types.includes(type), type);
  for (const r of received) {
    // Throws if the signature is invalid.
    resend.webhooks.verify({
      payload: r.body,
      headers: { id: r.headers['webhook-id'], timestamp: r.headers['webhook-timestamp'], signature: r.headers['webhook-signature'] },
      webhookSecret,
    });
  }
});

test('emails: batch, list, schedule and cancel, validation', async () => {
  const batch = await resend.batch.send([
    { from: FROM, to: 'one@example.com', subject: 'One', html: '<p>1</p>' },
    { from: FROM, to: 'two@example.com', subject: 'Two', text: '2' },
  ]);
  assert.equal(batch.error, null);
  assert.equal(batch.data?.data.length, 2);

  const scheduled = await resend.emails.send({ from: FROM, to: 'later@example.com', subject: 'Later', html: '<p>later</p>', scheduledAt: 'in 1 hour' });
  const sid = scheduled.data!.id;
  assert.equal((await resend.emails.get(sid)).data?.last_event, 'scheduled');
  assert.equal((await resend.emails.cancel(sid)).error, null);
  assert.equal((await resend.emails.get(sid)).data?.last_event, 'canceled');

  const page = await resend.emails.list({ limit: 2 });
  assert.equal(page.data?.data.length, 2);
  assert.equal(page.data?.has_more, true);
  const next = await resend.emails.list({ limit: 2, after: page.data!.data[1].id });
  assert.notEqual(next.data?.data[0].id, page.data!.data[0].id);

  const invalid = await resend.emails.send({ from: FROM, to: 'not-an-email', subject: 'x', html: 'x' });
  assert.equal(invalid.error?.name, 'validation_error');
});

test('contacts, segments and broadcasts with merge tags and one-click unsubscribe', async () => {
  const segment = await resend.segments.create({ name: 'Newsletter' });
  assert.equal(segment.error, null);
  const segmentId = segment.data!.id;
  await resend.contacts.create({ email: 'ada@example.com', firstName: 'Ada', segments: [{ id: segmentId }] });
  await resend.contacts.create({ email: 'nofirst@example.com', segments: [{ id: segmentId }] });
  await resend.contacts.create({ email: 'gone@example.com', unsubscribed: true, segments: [{ id: segmentId }] });
  const members = await resend.contacts.list({ segmentId });
  assert.equal(members.data?.data.length, 3);

  const created = await resend.broadcasts.create({
    name: 'Weekly',
    segmentId,
    from: FROM,
    subject: 'Hi {{{FIRST_NAME|there}}}',
    html: '<html><body><p>Hello {{{FIRST_NAME|friend}}}!</p></body></html>',
  });
  assert.equal(created.error, null);
  assert.equal((await resend.broadcasts.send(created.data!.id)).error, null);

  const sent = await waitFor(async () => {
    const list = (await resend.emails.list({ limit: 100 })).data!.data;
    const mine = list.filter((e) => e.subject.startsWith('Hi '));
    return mine.length === 2 && mine.every((e) => e.last_event === 'delivered') ? mine : null;
  }, 'broadcast fan-out');
  assert.deepEqual(sent.map((e) => e.subject).sort(), ['Hi Ada', 'Hi there'], 'unsubscribed contact skipped; fallbacks applied');

  const ada = sent.find((e) => e.subject === 'Hi Ada')!;
  const mime = await outbox(ada.id);
  assert.match(mime.html!, /Hello Ada!/);
  const listUnsubscribe = mime.headers.find((h) => h.key === 'list-unsubscribe')!.value.replace(/[<>]/g, '');
  assert.ok(mime.headers.some((h) => h.key === 'list-unsubscribe-post'));

  const oneClick = await fetch(listUnsubscribe, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
  assert.equal(oneClick.status, 200);
  assert.equal((await resend.contacts.get({ email: 'ada@example.com' })).data?.unsubscribed, true);
  assert.equal((await resend.broadcasts.get(created.data!.id)).data?.status, 'sent');
});

test('suppressions block sends', async () => {
  assert.equal((await resend.suppressions.add({ email: 'blocked@example.com' })).error, null);
  const res = await resend.emails.send({ from: FROM, to: 'blocked@example.com', subject: 'x', html: '<p>x</p>' });
  await waitFor(async () => (await resend.emails.get(res.data!.id)).data?.last_event === 'suppressed', 'suppression');
});

test('sending-only keys cannot manage resources', async () => {
  const key = await resend.apiKeys.create({ name: 'sender', permission: 'sending_access' });
  const sender = new Resend(key.data!.token, { baseUrl: BASE });
  assert.equal((await sender.domains.list()).error?.name, 'restricted_api_key');
  const ok = await sender.emails.send({ from: FROM, to: 'x@example.com', subject: 'ok', html: '<p>ok</p>' });
  assert.equal(ok.error, null);
});

test('dashboard requires login and renders every page', async () => {
  assert.equal((await fetch(`${BASE}/dashboard`, { redirect: 'manual' })).status, 302);
  const login = await fetch(`${BASE}/dashboard/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: 'test-password' }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const path of ['', '/emails', '/broadcasts', '/contacts', '/domains', `/domains/${domainId}`, '/api-keys', '/webhooks', '/suppressions', '/settings']) {
    const res = await fetch(`${BASE}/dashboard${path}`, { headers: { cookie } });
    assert.equal(res.status, 200, `/dashboard${path}`);
    assert.match(await res.text(), /SelfSend/);
  }
});

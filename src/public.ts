import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { html } from 'hono/html';
import { upsertContact } from './api/contacts.ts';
import { recordEmailEvent } from './events.ts';
import { handleSnsRequest } from './mail/ses-events.ts';
import { now, verifyToken } from './util.ts';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f7;color:#18181b;font:16px/1.5 system-ui,sans-serif}
  main{max-width:420px;margin:16px;padding:32px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;text-align:center}
  h1{font-size:20px;margin:0 0 8px} p{color:#52525b;margin:0 0 20px}
  button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#18181b;color:#fff;cursor:pointer}
  @media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#27272a}p{color:#a1a1aa}button{background:#fafafa;color:#09090b}}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export const publicRoutes = new Hono();

publicRoutes.get('/health', (c) => c.json({ ok: true }));

publicRoutes.get('/t/o/:token', (c) => {
  const data = verifyToken<{ e?: string }>(c.req.param('token'));
  if (data?.e) recordEmailEvent(data.e, 'opened');
  return c.body(PIXEL, 200, {
    'content-type': 'image/gif',
    'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  });
});

publicRoutes.get('/t/c/:token', (c) => {
  // The destination is inside the signed token, so this can never be used as an open redirect.
  const data = verifyToken<{ e?: string; u?: string }>(c.req.param('token'));
  if (!data?.u || !/^https?:\/\//i.test(data.u)) return c.text('Invalid link', 400);
  if (data.e) {
    recordEmailEvent(data.e, 'clicked', {
      click: { link: data.u, timestamp: now(), userAgent: c.req.header('user-agent') ?? '', ipAddress: clientIp(c) },
    });
  }
  return c.redirect(data.u, 302);
});

publicRoutes.get('/unsubscribe/:token', (c) => {
  const data = verifyToken<{ c?: string }>(c.req.param('token'));
  if (!data?.c) return c.html(page('Invalid link', html`<h1>Invalid link</h1><p>This unsubscribe link is not valid.</p>`), 400);
  return c.html(
    page(
      'Unsubscribe',
      html`<h1>Unsubscribe</h1>
        <p>Stop receiving marketing emails at <strong>${data.c}</strong>?</p>
        <form method="post"><button type="submit">Unsubscribe</button></form>`,
    ),
  );
});

// Handles both the confirmation form and RFC 8058 one-click (List-Unsubscribe-Post) requests from mailbox providers.
publicRoutes.post('/unsubscribe/:token', async (c) => {
  const data = verifyToken<{ c?: string }>(c.req.param('token'));
  if (!data?.c) return c.text('Invalid link', 400);
  upsertContact({ email: data.c, unsubscribed: true });
  const body = await c.req.text();
  if (body.includes('List-Unsubscribe=One-Click')) return c.text('Unsubscribed');
  return c.html(page('Unsubscribed', html`<h1>You're unsubscribed</h1><p>${data.c} will no longer receive these emails.</p>`));
});

publicRoutes.post('/hooks/ses', async (c) => {
  const result = await handleSnsRequest(await c.req.text());
  return c.text(result.message, result.status);
});

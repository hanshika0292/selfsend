import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { config } from '../config.ts';
import { all, one } from '../db.ts';
import type { EmailRow } from '../models.ts';
import { parseJson, safeEqual, signToken, verifyToken } from '../util.ts';
import { audiencePages } from './audience-pages.ts';
import { configPages } from './config-pages.ts';
import { render } from './helpers.ts';
import { bare, empty, money, percent, pill, time } from './layout.ts';
import { mailPages } from './mail-pages.ts';

const COOKIE = 'selfsend_session';
const SESSION_DAYS = 7;

export const dashboard = new Hono();

dashboard.get('/login', (c) =>
  c.html(
    bare(
      'Log in',
      html`<div class="brand" style="padding:0 0 16px"><i></i>SelfSend</div>
      ${config.adminPassword
        ? html`${c.req.query('error') ? html`<div class="flash error">Wrong password.</div>` : ''}
          <form method="post" action="/dashboard/login">
            <div class="field"><label>Admin password</label><input type="password" name="password" required autofocus></div>
            <button type="submit" style="width:100%;justify-content:center">Log in</button>
          </form>`
        : html`<p class="muted">Set the <span class="mono">ADMIN_PASSWORD</span> environment variable and restart to enable the dashboard.</p>`}`,
    ),
  ),
);

dashboard.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const password = typeof form.password === 'string' ? form.password : '';
  if (!config.adminPassword || !safeEqual(password, config.adminPassword)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return c.redirect('/dashboard/login?error=1');
  }
  setCookie(c, COOKIE, signToken({ exp: Date.now() + SESSION_DAYS * 864e5 }), {
    httpOnly: true,
    sameSite: 'Strict',
    secure: config.publicUrl.startsWith('https://'),
    path: '/dashboard',
    maxAge: SESSION_DAYS * 86400,
  });
  return c.redirect('/dashboard');
});

dashboard.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/dashboard' });
  return c.redirect('/dashboard/login');
});

dashboard.use('*', async (c, next) => {
  if (c.req.path === '/dashboard/login') return next();
  const session = verifyToken<{ exp?: number }>(getCookie(c, COOKIE) ?? '');
  if (!config.adminPassword || !session?.exp || session.exp < Date.now()) return c.redirect('/dashboard/login');
  await next();
});

// ---------------------------------------------------------------- overview

function count(sql: string, ...params: string[]): number {
  return one<{ n: number | null }>(sql, ...params)?.n ?? 0;
}

dashboard.get('/', (c) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const sentEmails = count('SELECT COUNT(*) n FROM emails WHERE sent_at >= ?', since);
  const recipients = count('SELECT SUM(recipients) n FROM emails WHERE sent_at >= ?', since);
  const unique = (type: string) => count('SELECT COUNT(DISTINCT email_id) n FROM email_events WHERE type = ? AND created_at >= ?', type, since);
  const delivered = unique('delivered');
  const opened = unique('opened');
  const clicked = unique('clicked');
  const bounced = unique('bounced');
  const complained = unique('complained');
  const queued = count("SELECT COUNT(*) n FROM emails WHERE status IN ('queued', 'sending')");
  const scheduled = count("SELECT COUNT(*) n FROM emails WHERE status = 'scheduled'");

  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString();
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  const monthRecipients = count('SELECT SUM(recipients) n FROM emails WHERE sent_at >= ?', monthStart);
  const projected = (monthRecipients / Math.max(1, today.getUTCDate())) * daysInMonth;
  const sendCost = (n: number) => (n / 1000) * config.pricePer1000;

  const days: { day: string; n: number }[] = [];
  const daily = new Map(
    all<{ day: string; n: number }>(
      'SELECT substr(sent_at, 1, 10) AS day, SUM(recipients) AS n FROM emails WHERE sent_at >= ? GROUP BY day',
      new Date(Date.now() - 14 * 864e5).toISOString(),
    ).map((r) => [r.day, r.n]),
  );
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ day, n: daily.get(day) ?? 0 });
  }
  const peak = Math.max(1, ...days.map((d) => d.n));
  const recent = all<EmailRow>('SELECT * FROM emails ORDER BY id DESC LIMIT 8');

  // AWS reviews accounts at 5% bounce / 0.1% complaint rate; warn well before that.
  const bounceRate = sentEmails ? bounced / sentEmails : 0;
  const complaintRate = sentEmails ? complained / sentEmails : 0;
  const warnings = [
    bounceRate > 0.03 ? `Bounce rate is ${percent(bounced, sentEmails)} (AWS reviews accounts at 5%). Clean your list.` : '',
    complaintRate > 0.0008 ? `Complaint rate is ${percent(complained, sentEmails)} (AWS reviews accounts at 0.1%).` : '',
  ].filter(Boolean);

  const stats: [string, string, string][] = [
    ['Sent (30d)', recipients.toLocaleString(), `${sentEmails.toLocaleString()} messages`],
    ['Delivered', percent(delivered, sentEmails), delivered.toLocaleString()],
    ['Opened', percent(opened, delivered || sentEmails), `${opened.toLocaleString()} unique`],
    ['Clicked', percent(clicked, delivered || sentEmails), `${clicked.toLocaleString()} unique`],
    ['Bounced', percent(bounced, sentEmails), bounced.toLocaleString()],
    ['Complained', percent(complained, sentEmails), complained.toLocaleString()],
  ];

  return render(
    c,
    'Overview',
    html`<h1>Overview</h1><p class="sub">Last 30 days · ${queued} queued · ${scheduled} scheduled · transport <span class="mono">${config.transport}</span></p>
    ${warnings.map((w) => html`<div class="flash error">${w}</div>`)}
    <div class="grid g6">${stats.map(
      ([label, value, hint]) => html`<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`,
    )}</div>
    <div class="grid g3">
      <div class="card" style="grid-column:span 2"><h2>Recipients per day</h2>
        <div class="chart" role="img" aria-label="Recipients per day, last 14 days">${days.map(
          (d) => html`<div class="bar" title="${d.day}: ${d.n}"><span style="height:${Math.round((d.n / peak) * 100)}%"></span><small>${d.day.slice(8)}</small></div>`,
        )}</div></div>
      <div class="card stat"><h2>Cost this month</h2>
        <div class="label">Sending (${monthRecipients.toLocaleString()} recipients × ${money(config.pricePer1000)}/1k)</div>
        <div class="value">${money(sendCost(monthRecipients))}</div>
        <div class="hint" style="margin-top:8px">Projected month: ${Math.round(projected).toLocaleString()} recipients ≈ ${money(sendCost(projected))} sending
          + ${money(config.fixedMonthlyCost)} hosting = <strong>${money(sendCost(projected) + config.fixedMonthlyCost)}</strong></div>
      </div>
    </div>
    <div class="card"><div class="row between"><h2>Recent emails</h2><a class="muted" href="/dashboard/emails">View all →</a></div>
      ${recent.length === 0
        ? empty('Nothing sent yet. Add a domain, create an API key, and send your first email.')
        : html`<div class="table-wrap"><table><tbody>${recent.map(
            (e) => html`<tr><td><a href="/dashboard/emails/${e.id}">${parseJson<string[]>(e.to_addrs, []).join(', ')}</a></td>
              <td>${e.subject}</td><td>${pill(e.last_event)}</td><td class="muted">${time(e.created_at)}</td></tr>`,
          )}</tbody></table></div>`}
    </div>`,
  );
});

// ---------------------------------------------------------------- settings

dashboard.get('/settings', (c) => {
  const rows: [string, string][] = [
    ['Public URL', config.publicUrl],
    ['Transport', config.transport],
    ['AWS region', config.awsRegion],
    ['SES configuration set', config.sesConfigurationSet || '(not set — bounce/complaint events disabled)'],
    ['SNS topic filter', config.sesSnsTopicArn || '(any topic, signature-verified)'],
    ['Send rate', `${config.sendRatePerSecond}/second`],
    ['Require verified domain', String(config.requireVerifiedDomain)],
    ['Footer postal address', config.companyAddress || '(not set — required for marketing email under CAN-SPAM)'],
  ];
  return render(
    c,
    'Settings',
    html`<h1>Settings</h1><p class="sub">Configured with environment variables; see <span class="mono">.env.example</span>.</p>
    <div class="card"><table><tbody>${rows.map(([k, v]) => html`<tr><td class="muted" style="width:220px">${k}</td><td class="mono">${v}</td></tr>`)}</tbody></table></div>
    <div class="card"><h2>Use it from your app (official Resend SDK, unchanged)</h2>
<pre>RESEND_API_KEY=re_…            # create one under API Keys
RESEND_BASE_URL=${config.publicUrl}

import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send({ from: 'You &lt;hi@yourdomain.com&gt;', to: 'a@b.com', subject: 'Hi', html: '&lt;p&gt;Hello&lt;/p&gt;' });</pre></div>
    <div class="card"><h2>SES bounce &amp; complaint events</h2>
      <p class="muted">Run <span class="mono">npm run cli -- setup-ses</span> once. It creates the configuration set, an SNS topic, and subscribes
      <span class="mono">${config.publicUrl}/hooks/ses</span> (confirmed automatically). Bounces and complaints then suppress addresses automatically.</p></div>`,
  );
});

dashboard.route('/', mailPages);
dashboard.route('/', audiencePages);
dashboard.route('/', configPages);

import { html, raw } from 'hono/html';

export type Html = ReturnType<typeof html>;

const NAV: [string, string][] = [
  ['/dashboard', 'Overview'],
  ['/dashboard/emails', 'Emails'],
  ['/dashboard/broadcasts', 'Broadcasts'],
  ['/dashboard/contacts', 'Contacts'],
  ['/dashboard/domains', 'Domains'],
  ['/dashboard/api-keys', 'API Keys'],
  ['/dashboard/webhooks', 'Webhooks'],
  ['/dashboard/suppressions', 'Suppressions'],
  ['/dashboard/settings', 'Settings'],
];

const CSS = `
:root{--bg:#09090b;--panel:#111113;--panel-2:#18181b;--border:#26262b;--text:#ededef;--muted:#9d9da6;--faint:#6b6b75;
--accent:#fafafa;--accent-text:#09090b;--green:#3ecf8e;--blue:#60a5fa;--red:#f87171;--amber:#fbbf24;--purple:#c084fc;--orange:#fb923c;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#ffffff;--panel-2:#f4f4f5;--border:#e4e4e7;--text:#18181b;--muted:#52525b;--faint:#a1a1aa;
--accent:#18181b;--accent-text:#fafafa;--green:#16a34a;--blue:#2563eb;--red:#dc2626;--amber:#b45309;--purple:#9333ea;--orange:#ea580c;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:inherit}
.shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
aside{border-right:1px solid var(--border);padding:20px 12px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;padding:4px 10px 20px}
.brand i{width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,var(--text),var(--faint));display:inline-block}
nav a{display:block;padding:7px 10px;border-radius:6px;color:var(--muted);text-decoration:none;margin-bottom:2px}
nav a:hover{background:var(--panel-2);color:var(--text)}
nav a.on{background:var(--panel-2);color:var(--text);font-weight:500}
aside form{position:absolute;bottom:20px;left:12px;right:12px}
main{padding:28px 36px 64px;max-width:1180px;width:100%;min-width:0}
h1{font-size:22px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:15px;font-weight:600;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.between{justify-content:space-between}
.grid{display:grid;gap:16px}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g6{grid-template-columns:repeat(6,minmax(0,1fr))}
.split{display:grid;grid-template-columns:240px minmax(0,1fr);gap:20px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:18px;min-width:0}
.card+.card,.card+.grid,.grid+.card,.grid+.grid{margin-top:16px}
.grid>.card{margin-top:0}
.stat .label{color:var(--muted);font-size:12px}
.stat .value{font-size:24px;font-weight:600;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums}
.stat .hint{color:var(--faint);font-size:12px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:anywhere}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--panel-2)}
.table-wrap{overflow-x:auto;margin:-6px -8px}
.table-wrap table{min-width:560px}
time{white-space:nowrap}
.mono{font-family:var(--mono);font-size:12.5px}
.muted{color:var(--muted)}.faint{color:var(--faint)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--border);white-space:nowrap;background:var(--panel-2)}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--faint)}
.pill.green::before{background:var(--green)}.pill.blue::before{background:var(--blue)}.pill.red::before{background:var(--red)}
.pill.amber::before{background:var(--amber)}.pill.purple::before{background:var(--purple)}.pill.orange::before{background:var(--orange)}
label{display:block;font-size:12px;color:var(--muted);margin:0 0 4px}
input,select,textarea{width:100%;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:8px 10px}
textarea{font-family:var(--mono);font-size:12.5px;min-height:140px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--blue);outline-offset:-1px}
input[type=checkbox]{width:auto}
.field{margin-bottom:12px}
.check{display:flex;gap:8px;align-items:center;color:var(--text);font-size:13px;margin:0}
button,.btn{font:inherit;font-weight:500;display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);cursor:pointer;text-decoration:none;white-space:nowrap}
button.ghost,.btn.ghost{background:transparent;color:var(--text);border-color:var(--border)}
button.ghost:hover,.btn.ghost:hover{background:var(--panel-2)}
button.danger{background:transparent;color:var(--red);border-color:var(--border)}
button.small,.btn.small{padding:4px 10px;font-size:12px}
form.inline{display:inline}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:20px;border:1px solid var(--border);background:var(--panel)}
.flash.ok{border-color:color-mix(in srgb,var(--green) 50%,var(--border))}
.flash.error{border-color:color-mix(in srgb,var(--red) 60%,var(--border));color:var(--red)}
.secret{font-family:var(--mono);font-size:13px;padding:12px;border-radius:8px;background:var(--bg);border:1px dashed var(--border);overflow-wrap:anywhere;user-select:all}
.chart{display:flex;align-items:flex-end;gap:4px;height:140px;padding-top:8px}
.chart .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0;height:100%}
.chart .bar span{width:100%;max-width:28px;background:var(--text);opacity:.85;border-radius:3px 3px 0 0;min-height:1px}
.chart .bar small{color:var(--faint);font-size:10px;margin-top:4px;white-space:nowrap}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:flex;gap:12px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--border)}
.timeline li:last-child{border-bottom:0}
iframe.preview{width:100%;height:520px;border:1px solid var(--border);border-radius:8px;background:#fff}
pre{white-space:pre-wrap;margin:0;font-family:var(--mono);font-size:12.5px}
.seglist a{display:flex;justify-content:space-between;padding:7px 10px;border-radius:6px;text-decoration:none;color:var(--muted)}
.seglist a.on,.seglist a:hover{background:var(--panel-2);color:var(--text)}
.warn{border-color:color-mix(in srgb,var(--amber) 55%,var(--border))}
.pager{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
details summary{cursor:pointer;color:var(--muted)}
@media (max-width:900px){
  .shell{grid-template-columns:minmax(0,1fr)}
  aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--border);padding:12px 16px}
  aside nav{display:flex;overflow-x:auto;gap:2px}
  aside nav a{white-space:nowrap}
  aside form{position:static;margin-top:8px}
  .brand{padding:4px 0 10px}
  main{padding:20px 16px 48px}
  .g2,.g3,.split{grid-template-columns:1fr}.g6{grid-template-columns:repeat(2,minmax(0,1fr))}
}
`;

// Renders <time data-ts> in the viewer's own timezone.
const TIME_SCRIPT = `
document.querySelectorAll('time[data-ts]').forEach(function(t){
  var d=new Date(t.dataset.ts); if(isNaN(d)) return;
  t.textContent=d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  t.title=d.toString();
});`;

export function layout(options: { title: string; path: string; body: Html; flash?: { ok?: string; error?: string } }): Html {
  const active = NAV.filter(([href]) => options.path === href || options.path.startsWith(`${href}/`)).pop()?.[0];
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title} · SelfSend</title>
<style>${raw(CSS)}</style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="brand"><i></i>SelfSend</div>
    <nav>${NAV.map(([href, label]) => html`<a href="${href}" class="${href === active ? 'on' : ''}">${label}</a>`)}</nav>
    <form method="post" action="/dashboard/logout"><button class="ghost small" type="submit">Log out</button></form>
  </aside>
  <main>
    ${options.flash?.ok ? html`<div class="flash ok">${options.flash.ok}</div>` : ''}
    ${options.flash?.error ? html`<div class="flash error">${options.flash.error}</div>` : ''}
    ${options.body}
  </main>
</div>
<script>${raw(TIME_SCRIPT)}</script>
</body>
</html>`;
}

export function bare(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · SelfSend</title>
<style>${raw(CSS)} body{display:grid;place-items:center;min-height:100vh} .card{width:min(380px,calc(100vw - 32px))}</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

const PILL_COLORS: Record<string, string> = {
  delivered: 'green',
  verified: 'green',
  enabled: 'green',
  sent: 'green',
  opened: 'blue',
  clicked: 'blue',
  queued: '',
  sending: '',
  draft: '',
  scheduled: 'purple',
  pending: 'amber',
  partially_verified: 'amber',
  delivery_delayed: 'amber',
  not_started: '',
  bounced: 'red',
  failed: 'red',
  partially_failed: 'red',
  temporary_failure: 'amber',
  complained: 'orange',
  suppressed: '',
  canceled: '',
  disabled: '',
  unsubscribed: 'orange',
  subscribed: 'green',
};

export function pill(status: string): Html {
  return html`<span class="pill ${PILL_COLORS[status] ?? ''}">${status.replace(/_/g, ' ')}</span>`;
}

export function time(iso: string | null | undefined): Html {
  if (!iso) return html`<span class="faint">—</span>`;
  return html`<time data-ts="${iso}">${iso.slice(0, 16).replace('T', ' ')} UTC</time>`;
}

export function empty(message: string): Html {
  return html`<p class="muted" style="margin:8px 0">${message}</p>`;
}

export function percent(part: number, whole: number): string {
  if (!whole) return '—';
  return `${((part / whole) * 100).toFixed(part / whole < 0.01 ? 2 : 1)}%`;
}

export function money(value: number): string {
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

import { config } from '../config.ts';
import type { ContactRow } from '../models.ts';
import { parseJson, signToken } from '../util.ts';

const PLACEHOLDER = /\{\{\{\s*([A-Za-z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}\}/g;
const UNSUBSCRIBE_KEYS = new Set(['RESEND_UNSUBSCRIBE_URL', 'UNSUBSCRIBE_URL']);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unsubscribeUrl(email: string): string {
  return `${config.publicUrl}/unsubscribe/${signToken({ c: email.toLowerCase() })}`;
}

export function hasUnsubscribePlaceholder(content: string): boolean {
  for (const match of content.matchAll(PLACEHOLDER)) {
    if (UNSUBSCRIBE_KEYS.has(match[1].toUpperCase())) return true;
  }
  return false;
}

/** Resend-style triple-brace merge tags: {{{FIRST_NAME|there}}}, {{{EMAIL}}}, {{{RESEND_UNSUBSCRIBE_URL}}}, {{{any_property|fallback}}}. */
export function personalize(template: string, contact: ContactRow, unsubscribe: string, html: boolean): string {
  const properties = parseJson<Record<string, unknown>>(contact.properties, {});
  return template.replace(PLACEHOLDER, (_match, rawKey: string, fallback: string | undefined) => {
    const key = rawKey.toUpperCase();
    if (UNSUBSCRIBE_KEYS.has(key)) return unsubscribe;
    let value: unknown;
    if (key === 'FIRST_NAME') value = contact.first_name;
    else if (key === 'LAST_NAME') value = contact.last_name;
    else if (key === 'EMAIL') value = contact.email;
    else value = properties[rawKey] ?? properties[rawKey.toLowerCase()];
    const text = value === null || value === undefined || value === '' ? (fallback ?? '') : String(value);
    return html ? escapeHtml(text) : text;
  });
}

function insertBeforeBodyEnd(html: string, snippet: string): string {
  const index = html.search(/<\/body>/i);
  return index === -1 ? html + snippet : html.slice(0, index) + snippet + html.slice(index);
}

function insertAfterBodyStart(html: string, snippet: string): string {
  const match = html.match(/<body[^>]*>/i);
  if (!match || match.index === undefined) return snippet + html;
  const at = match.index + match[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

export function broadcastHtml(html: string, previewText: string | null): string {
  let out = html;
  if (previewText) {
    out = insertAfterBodyStart(
      out,
      `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(previewText)}</div>`,
    );
  }
  if (!hasUnsubscribePlaceholder(out)) {
    const address = config.companyAddress ? `<br>${escapeHtml(config.companyAddress)}` : '';
    out = insertBeforeBodyEnd(
      out,
      `<p style="margin-top:32px;font-size:12px;color:#8a8f98;font-family:sans-serif">` +
        `You are receiving this email because you subscribed. ` +
        `<a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#8a8f98">Unsubscribe</a>${address}</p>`,
    );
  }
  return out;
}

export function broadcastText(text: string): string {
  if (hasUnsubscribePlaceholder(text)) return text;
  const address = config.companyAddress ? `\n${config.companyAddress}` : '';
  return `${text}\n\n--\nUnsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}${address}`;
}

/** Rewrites http(s) links through the click tracker and appends an open pixel. Unsubscribe links are left untouched. */
export function addTracking(html: string, emailId: string, options: { open: boolean; click: boolean }): string {
  let out = html;
  if (options.click) {
    out = out.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (match, prefix: string, quote: string, href: string) => {
      const url = href.replace(/&amp;/g, '&');
      if (url.startsWith(`${config.publicUrl}/unsubscribe/`)) return match;
      return `${prefix}${quote}${config.publicUrl}/t/c/${signToken({ e: emailId, u: url })}${quote}`;
    });
  }
  if (options.open) {
    const pixel = `<img src="${config.publicUrl}/t/o/${signToken({ e: emailId })}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
    out = insertBeforeBodyEnd(out, pixel);
  }
  return out;
}

import type { Context } from 'hono';
import { layout, type Html } from './layout.ts';

export type Form = Record<string, string | File | (string | File)[]>;

export function render(c: Context, title: string, body: Html, status: 200 | 400 | 404 = 200) {
  const flash = { ok: c.req.query('ok'), error: c.req.query('error') };
  return c.html(layout({ title, path: c.req.path, body, flash }), status);
}

export function str(form: Form, key: string): string {
  const value = form[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

export function list(form: Form, key: string): string[] {
  const value = form[key];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((v): v is string => typeof v === 'string');
}

function withFlash(to: string, kind: 'ok' | 'error', message: string): string {
  const url = new URL(to, 'http://x');
  url.searchParams.set(kind, message);
  return `${url.pathname}${url.search}`;
}

/** Runs a form action and redirects back with a flash message (Post/Redirect/Get). */
export async function action(
  c: Context,
  fallback: string,
  fn: (form: Form) => Promise<{ to?: string; ok?: string } | void> | { to?: string; ok?: string } | void,
) {
  try {
    const form = (await c.req.parseBody({ all: true })) as Form;
    const result = (await fn(form)) ?? {};
    return c.redirect(withFlash(result.to ?? fallback, 'ok', result.ok ?? 'Saved'));
  } catch (err) {
    return c.redirect(withFlash(fallback, 'error', err instanceof Error ? err.message : String(err)));
  }
}

export function offsetParam(c: Context): number {
  const page = Number(c.req.query('page') ?? 1);
  return Number.isInteger(page) && page > 1 ? page : 1;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((cell) => cell.trim()));
}

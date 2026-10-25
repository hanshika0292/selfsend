import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appSecret } from './db.ts';

export function now(): string {
  return new Date().toISOString();
}

/** Time-ordered UUID (RFC 9562 v7), so ids double as pagination cursors. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a));
  const bb = Buffer.from(sha256(b));
  return timingSafeEqual(ab, bb);
}

/** API keys use Resend's `re_` prefix so existing tooling and secret scanners recognise them. */
export function generateApiKey(): string {
  return `re_${randomBytes(24).toString('base64url')}`;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function mac(payload: string): string {
  return createHmac('sha256', appSecret).update(payload).digest('base64url').slice(0, 27);
}

/** Compact signed token: base64url(JSON) + "." + truncated HMAC. Not encrypted, only tamper-proof. */
export function signToken(data: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

export function verifyToken<T>(token: string): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, mac(payload))) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

export function toArray(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Extracts the bare address from `email@x.com` or `Name <email@x.com>`; null if malformed. */
export function bareAddress(value: string): string | null {
  const trimmed = value.trim();
  const angle = trimmed.match(/<([^<>]+)>\s*$/);
  const address = (angle ? angle[1] : trimmed).trim();
  return ADDRESS_RE.test(address) ? address.toLowerCase() : null;
}

export function addressDomain(value: string): string | null {
  const address = bareAddress(value);
  return address ? address.slice(address.lastIndexOf('@') + 1) : null;
}

/** Accepts ISO 8601 or Resend-style natural language such as "in 10 min" / "in 2 hours". */
export function parseScheduledAt(value: string): Date | null {
  const relative = value.trim().toLowerCase().match(/^in\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2][0];
    const ms = unit === 's' ? 1e3 : unit === 'm' ? 6e4 : unit === 'h' ? 36e5 : 864e5;
    return new Date(Date.now() + amount * ms);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

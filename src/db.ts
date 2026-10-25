import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'full_access',
  domain_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL,
  region TEXT NOT NULL,
  return_path TEXT NOT NULL DEFAULT 'send',
  open_tracking INTEGER NOT NULL DEFAULT 0,
  click_tracking INTEGER NOT NULL DEFAULT 0,
  records TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  from_addr TEXT NOT NULL,
  to_addrs TEXT NOT NULL,
  cc TEXT,
  bcc TEXT,
  reply_to TEXT,
  subject TEXT NOT NULL,
  html TEXT,
  text TEXT,
  headers TEXT,
  tags TEXT,
  attachments TEXT,
  broadcast_id TEXT,
  status TEXT NOT NULL,
  last_event TEXT NOT NULL,
  scheduled_at TEXT,
  send_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  message_id TEXT,
  provider_id TEXT,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS emails_due ON emails(status, send_after);
CREATE INDEX IF NOT EXISTS emails_provider ON emails(provider_id);
CREATE INDEX IF NOT EXISTS emails_broadcast ON emails(broadcast_id);
CREATE INDEX IF NOT EXISTS emails_sent_at ON emails(sent_at);

CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_events_email ON email_events(email_id);
CREATE INDEX IF NOT EXISTS email_events_type ON email_events(type, created_at);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT,
  last_name TEXT,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_segments (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, segment_id)
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  name TEXT,
  segment_id TEXT,
  from_addr TEXT,
  subject TEXT,
  reply_to TEXT,
  preview_text TEXT,
  html TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  api_key_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, key)
);
`;

function open(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(SCHEMA);
  return database;
}

export const db = open(config.databasePath);

type Param = SQLInputValue | boolean | undefined;

function bind(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function one<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...bind(params)) as T | undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...bind(params)) as T[];
}

export function run(sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...bind(params)).changes);
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Secret used to sign tracking links, unsubscribe links and dashboard sessions. Generated once and persisted. */
export const appSecret: string = (() => {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const existing = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'app_secret');
  if (existing) return existing.value;
  const generated = randomBytes(32).toString('base64url');
  run('INSERT INTO settings (key, value) VALUES (?, ?)', 'app_secret', generated);
  return generated;
})();

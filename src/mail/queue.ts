import { run } from '../db.ts';
import { recordEmailEvent } from '../events.ts';
import type { StoredAttachment, Tag } from '../models.ts';
import { now, uuidv7 } from '../util.ts';

export type NewEmail = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  tags?: Tag[];
  attachments?: StoredAttachment[];
  scheduledAt?: Date | null;
  broadcastId?: string;
};

const jsonOrNull = (value: unknown[] | Record<string, unknown> | undefined) =>
  value === undefined || (Array.isArray(value) && value.length === 0) ? null : JSON.stringify(value);

/** Persists an email for the worker to send. Anything scheduled more than a second out waits until `scheduled_at`. */
export function enqueueEmail(input: NewEmail): string {
  const id = uuidv7();
  const createdAt = now();
  const scheduledAt = input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 1000 ? input.scheduledAt.toISOString() : null;
  const status = scheduledAt ? 'scheduled' : 'queued';
  run(
    `INSERT INTO emails (id, from_addr, to_addrs, cc, bcc, reply_to, subject, html, text, headers, tags, attachments,
       broadcast_id, status, last_event, scheduled_at, send_after, recipients, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.from,
    JSON.stringify(input.to),
    jsonOrNull(input.cc),
    jsonOrNull(input.bcc),
    jsonOrNull(input.replyTo),
    input.subject,
    input.html ?? null,
    input.text ?? null,
    input.headers && Object.keys(input.headers).length ? JSON.stringify(input.headers) : null,
    jsonOrNull(input.tags),
    jsonOrNull(input.attachments),
    input.broadcastId ?? null,
    status,
    status,
    scheduledAt,
    scheduledAt ?? createdAt,
    input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
    createdAt,
  );
  if (scheduledAt) recordEmailEvent(id, 'scheduled');
  return id;
}

import { all, one, run } from './db.ts';
import type { EmailRow, Tag, WebhookRow } from './models.ts';
import { bareAddress, now, parseJson, uuidv7 } from './util.ts';

export type EmailEventType =
  | 'scheduled'
  | 'sent'
  | 'delivered'
  | 'delivery_delayed'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed'
  | 'suppressed'
  | 'canceled';

/** Events can arrive out of order (an open before SES reports delivery); never let a weaker event overwrite a stronger one. */
const RANK: Record<string, number> = {
  queued: 0,
  scheduled: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  bounced: 8,
  complained: 8,
  failed: 8,
  suppressed: 8,
  canceled: 9,
};

export function addSuppression(email: string, reason: string): void {
  run('INSERT OR IGNORE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)', email.toLowerCase(), reason, now());
}

export function isSuppressed(email: string): boolean {
  return one('SELECT 1 FROM suppressions WHERE email = ?', email.toLowerCase()) !== undefined;
}

/** Queues a signed delivery to every enabled webhook subscribed to `type`. */
export function dispatchWebhookEvent(type: string, data: Record<string, unknown>): void {
  const hooks = all<WebhookRow>("SELECT * FROM webhooks WHERE status = 'enabled'");
  if (hooks.length === 0) return;
  const createdAt = now();
  const payload = JSON.stringify({ type, created_at: createdAt, data });
  for (const hook of hooks) {
    const events = parseJson<string[]>(hook.events, []);
    if (events.length > 0 && !events.includes(type)) continue;
    run(
      'INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      uuidv7(),
      hook.id,
      type,
      payload,
      createdAt,
      createdAt,
    );
  }
}

export function recordEmailEvent(emailId: string, type: EmailEventType, extra: Record<string, unknown> = {}): void {
  const email = one<EmailRow>('SELECT * FROM emails WHERE id = ?', emailId);
  if (!email) return;
  const createdAt = now();
  run(
    'INSERT INTO email_events (id, email_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)',
    uuidv7(),
    emailId,
    type,
    Object.keys(extra).length ? JSON.stringify(extra) : null,
    createdAt,
  );
  if ((RANK[type] ?? 0) >= (RANK[email.last_event] ?? 0)) {
    run('UPDATE emails SET last_event = ? WHERE id = ?', type, emailId);
  }

  const tags = parseJson<Tag[]>(email.tags, []);
  dispatchWebhookEvent(`email.${type}`, {
    email_id: email.id,
    ...(email.broadcast_id ? { broadcast_id: email.broadcast_id } : {}),
    created_at: email.created_at,
    from: email.from_addr,
    to: parseJson<string[]>(email.to_addrs, []),
    subject: email.subject,
    message_id: email.message_id,
    ...(tags.length ? { tags: Object.fromEntries(tags.map((t) => [t.name, t.value])) } : {}),
    ...extra,
  });
}

/** Hard bounces and complaints suppress the address; complaints also unsubscribe the contact from broadcasts. */
export function applyFeedback(kind: 'bounce' | 'complaint', addresses: string[]): void {
  for (const raw of addresses) {
    const address = bareAddress(raw);
    if (!address) continue;
    addSuppression(address, kind);
    if (kind === 'complaint') run('UPDATE contacts SET unsubscribed = 1 WHERE email = ?', address);
  }
}

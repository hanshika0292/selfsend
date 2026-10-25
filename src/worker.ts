import { createHmac } from 'node:crypto';
import { config } from './config.ts';
import { all, one, run, tx } from './db.ts';
import { isSuppressed, recordEmailEvent } from './events.ts';
import { addTracking, broadcastHtml, broadcastText, personalize, unsubscribeUrl } from './mail/compose.ts';
import { enqueueEmail } from './mail/queue.ts';
import { isRetryable, sendMail } from './mail/transport.ts';
import type { BroadcastRow, ContactRow, DomainRow, EmailRow, StoredAttachment, Tag } from './models.ts';
import { addressDomain, bareAddress, now, parseJson } from './util.ts';

const SEND_RETRY_SECONDS = [30, 120, 600, 1800];
const WEBHOOK_RETRY_SECONDS = [5, 300, 1800, 7200, 18000, 36000];

let running = false;
let rerun = false;
let windowStart = 0;
let sentInWindow = 0;
let lastHousekeeping = 0;

export function startWorker(): () => void {
  // Anything mid-send when the process died goes back on the queue.
  run("UPDATE emails SET status = 'queued' WHERE status = 'sending'");
  const timer = setInterval(() => void tick(), 1000);
  void tick();
  return () => clearInterval(timer);
}

export function wakeWorker(): void {
  setImmediate(() => void tick());
}

async function tick(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    fanOutDueBroadcasts();
    await sendDueEmails();
    await deliverDueWebhooks();
    housekeeping();
  } catch (err) {
    console.error('[worker]', err);
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      setImmediate(() => void tick());
    }
  }
}

// ---------------------------------------------------------------- emails

async function sendDueEmails(): Promise<void> {
  const t = Date.now();
  if (t - windowStart >= 1000) {
    windowStart = t;
    sentInWindow = 0;
  }
  const budget = config.sendRatePerSecond - sentInWindow;
  if (budget <= 0) return;

  const due = all<EmailRow>(
    "SELECT * FROM emails WHERE status IN ('queued', 'scheduled') AND send_after <= ? ORDER BY send_after LIMIT ?",
    now(),
    budget,
  );
  if (due.length === 0) return;
  sentInWindow += due.length;
  for (const email of due) run("UPDATE emails SET status = 'sending' WHERE id = ?", email.id);
  await Promise.all(due.map(deliverEmail));
}

function deliverable(list: string | null): string[] {
  return parseJson<string[]>(list, []).filter((address) => {
    const bare = bareAddress(address);
    return bare !== null && !isSuppressed(bare);
  });
}

async function deliverEmail(email: EmailRow): Promise<void> {
  const to = deliverable(email.to_addrs);
  const cc = deliverable(email.cc);
  const bcc = deliverable(email.bcc);
  if (to.length === 0) {
    run("UPDATE emails SET status = 'suppressed' WHERE id = ?", email.id);
    recordEmailEvent(email.id, 'suppressed', { suppressed: { message: 'All recipients are on the suppression list' } });
    return;
  }

  const fromDomain = addressDomain(email.from_addr) ?? 'localhost';
  const domain = one<DomainRow>('SELECT * FROM domains WHERE name = ?', fromDomain);
  let html = email.html;
  if (html && domain) {
    html = addTracking(html, email.id, { open: domain.open_tracking === 1, click: domain.click_tracking === 1 });
  }
  const tags = parseJson<Tag[]>(email.tags, []);
  const attachments = parseJson<StoredAttachment[]>(email.attachments, []).map((a) => ({
    filename: a.filename,
    content: a.content ? Buffer.from(a.content, 'base64') : undefined,
    path: a.path,
    contentType: a.content_type,
    cid: a.content_id,
  }));

  try {
    const result = await sendMail(
      {
        from: email.from_addr,
        to,
        cc,
        bcc,
        replyTo: parseJson<string[]>(email.reply_to, []),
        subject: email.subject,
        html: html ?? undefined,
        text: email.text ?? undefined,
        headers: parseJson<Record<string, string>>(email.headers, {}),
        attachments,
        messageId: `<${email.id}@${fromDomain}>`,
        ses: {
          ConfigurationSetName: config.sesConfigurationSet || undefined,
          EmailTags: [{ Name: 'selfsend_email_id', Value: email.id }, ...tags.map((t) => ({ Name: t.name, Value: t.value }))],
        },
      },
      email.id,
    );
    run(
      "UPDATE emails SET status = 'sent', sent_at = ?, provider_id = ?, message_id = ?, recipients = ?, error = NULL WHERE id = ?",
      now(),
      result.providerId,
      result.messageId,
      to.length + cc.length + bcc.length,
      email.id,
    );
    recordEmailEvent(email.id, 'sent');
    // The log transport has no delivery feedback loop, so simulate one to keep dashboards meaningful in dev.
    if (config.transport === 'log') recordEmailEvent(email.id, 'delivered', { simulated: true });
  } catch (err) {
    const attempts = email.attempts + 1;
    const reason = err instanceof Error ? err.message : String(err);
    if (!isRetryable(err) || attempts >= config.maxSendAttempts) {
      run("UPDATE emails SET status = 'failed', attempts = ?, error = ? WHERE id = ?", attempts, reason, email.id);
      recordEmailEvent(email.id, 'failed', { failed: { reason } });
      console.error(`[worker] email ${email.id} failed permanently: ${reason}`);
    } else {
      const delay = SEND_RETRY_SECONDS[attempts - 1] ?? 3600;
      run(
        "UPDATE emails SET status = 'queued', attempts = ?, error = ?, send_after = ? WHERE id = ?",
        attempts,
        reason,
        new Date(Date.now() + delay * 1000).toISOString(),
        email.id,
      );
      console.warn(`[worker] email ${email.id} attempt ${attempts} failed, retrying in ${delay}s: ${reason}`);
    }
  }
}

// ------------------------------------------------------------ broadcasts

function fanOutDueBroadcasts(): void {
  const due = all<BroadcastRow>(
    "SELECT * FROM broadcasts WHERE status = 'queued' AND (scheduled_at IS NULL OR scheduled_at <= ?)",
    now(),
  );
  for (const broadcast of due) fanOutBroadcast(broadcast);
}

/** Expands a broadcast into one personalised email per subscribed, non-suppressed contact in its segment. */
export function fanOutBroadcast(broadcast: BroadcastRow): number {
  const contacts = all<ContactRow>(
    `SELECT c.* FROM contacts c
       JOIN contact_segments cs ON cs.contact_id = c.id
      WHERE cs.segment_id = ? AND c.unsubscribed = 0
        AND c.email NOT IN (SELECT email FROM suppressions)`,
    broadcast.segment_id,
  );
  const html = broadcast.html ? broadcastHtml(broadcast.html, broadcast.preview_text) : null;
  const text = broadcast.text ? broadcastText(broadcast.text) : null;
  const replyTo = parseJson<string[]>(broadcast.reply_to, []);

  tx(() => {
    for (const contact of contacts) {
      const unsubscribe = unsubscribeUrl(contact.email);
      enqueueEmail({
        from: broadcast.from_addr ?? '',
        to: [contact.email],
        replyTo,
        subject: personalize(broadcast.subject ?? '', contact, unsubscribe, false),
        html: html ? personalize(html, contact, unsubscribe, true) : null,
        text: text ? personalize(text, contact, unsubscribe, false) : null,
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        broadcastId: broadcast.id,
      });
    }
    run("UPDATE broadcasts SET status = 'sent', sent_at = ? WHERE id = ?", now(), broadcast.id);
  });
  console.log(`[worker] broadcast ${broadcast.id} queued for ${contacts.length} contacts`);
  return contacts.length;
}

// -------------------------------------------------------------- webhooks

type DueDelivery = {
  id: string;
  payload: string;
  attempts: number;
  endpoint: string;
  secret: string;
};

/** Standard Webhooks signature (what Svix and `resend.webhooks.verify()` check). */
export function signWebhook(secret: string, id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')}`;
}

async function deliverDueWebhooks(): Promise<void> {
  const due = all<DueDelivery>(
    `SELECT d.id, d.payload, d.attempts, w.endpoint, w.secret
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.status = 'enabled'
      ORDER BY d.next_attempt_at LIMIT 20`,
    now(),
  );
  await Promise.all(due.map(deliverWebhook));
}

async function deliverWebhook(delivery: DueDelivery): Promise<void> {
  const messageId = `msg_${delivery.id}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhook(delivery.secret, messageId, timestamp, delivery.payload);
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(delivery.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'selfsend-webhooks/1',
        'webhook-id': messageId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
        'svix-id': messageId,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(15_000),
    });
    statusCode = res.status;
    if (res.ok) {
      run("UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status_code = ?, last_error = NULL WHERE id = ?", statusCode, delivery.id);
      return;
    }
    error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const attempts = delivery.attempts + 1;
  const delay = WEBHOOK_RETRY_SECONDS[attempts - 1];
  run(
    'UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
    delay === undefined ? 'failed' : 'pending',
    attempts,
    statusCode,
    error,
    new Date(Date.now() + (delay ?? 0) * 1000).toISOString(),
    delivery.id,
  );
}

// ---------------------------------------------------------- housekeeping

function housekeeping(): void {
  if (Date.now() - lastHousekeeping < 10 * 60_000) return;
  lastHousekeeping = Date.now();
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
  run('DELETE FROM idempotency_keys WHERE created_at < ?', dayAgo);
  run("DELETE FROM webhook_deliveries WHERE status = 'delivered' AND created_at < ?", monthAgo);
}

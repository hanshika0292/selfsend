import { createVerify } from 'node:crypto';
import { config } from '../config.ts';
import { one, run } from '../db.ts';
import { applyFeedback, recordEmailEvent } from '../events.ts';

type SnsMessage = {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

type SesEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]> };
  bounce?: {
    bounceType: string;
    bounceSubType: string;
    bouncedRecipients: { emailAddress: string; diagnosticCode?: string }[];
  };
  complaint?: { complainedRecipients: { emailAddress: string }[]; complaintFeedbackType?: string };
  reject?: { reason?: string };
  failure?: { errorMessage?: string };
};

// Canonical field order for SNS signatures: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const CONFIRMATION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const;
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

const certCache = new Map<string, string>();

function isSnsUrl(value: string | undefined, pem: boolean): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname) && (!pem || url.pathname.endsWith('.pem'));
  } catch {
    return false;
  }
}

async function signingCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Could not fetch SNS signing certificate (${res.status})`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

async function verifySignature(message: SnsMessage): Promise<boolean> {
  if (!isSnsUrl(message.SigningCertURL, true)) return false;
  const fields = message.Type === 'Notification' ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  const canonical = fields
    .filter((field) => message[field] !== undefined && message[field] !== null)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('');
  const algorithm = message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  const cert = await signingCert(message.SigningCertURL);
  return createVerify(algorithm).update(canonical, 'utf8').verify(cert, message.Signature, 'base64');
}

function findEmailId(event: SesEvent): string | undefined {
  const tagged = event.mail?.tags?.selfsend_email_id?.[0];
  if (tagged) return tagged;
  const messageId = event.mail?.messageId;
  if (!messageId) return undefined;
  return one<{ id: string }>('SELECT id FROM emails WHERE provider_id = ?', messageId)?.id;
}

export function handleSesEvent(event: SesEvent): void {
  const emailId = findEmailId(event);
  if (!emailId) return;
  switch (event.eventType ?? event.notificationType) {
    case 'Delivery':
      recordEmailEvent(emailId, 'delivered');
      break;
    case 'DeliveryDelay':
      recordEmailEvent(emailId, 'delivery_delayed');
      break;
    case 'Bounce': {
      const bounce = event.bounce;
      if (!bounce) break;
      if (bounce.bounceType === 'Permanent') applyFeedback('bounce', bounce.bouncedRecipients.map((r) => r.emailAddress));
      recordEmailEvent(emailId, 'bounced', {
        bounce: {
          type: bounce.bounceType,
          subType: bounce.bounceSubType,
          message: bounce.bouncedRecipients[0]?.diagnosticCode ?? '',
        },
      });
      break;
    }
    case 'Complaint':
      applyFeedback('complaint', event.complaint?.complainedRecipients.map((r) => r.emailAddress) ?? []);
      recordEmailEvent(emailId, 'complained');
      break;
    case 'Reject':
    case 'Rendering Failure': {
      const reason = event.reject?.reason ?? event.failure?.errorMessage ?? 'Rejected by SES';
      run("UPDATE emails SET status = 'failed', error = ? WHERE id = ?", reason, emailId);
      recordEmailEvent(emailId, 'failed', { failed: { reason } });
      break;
    }
    default:
      // Send/Open/Click from SES are ignored: sends are recorded by the worker and opens/clicks by our own tracker.
      break;
  }
}

/** Entry point for SES -> SNS -> HTTPS. Every message is signature-verified before it is trusted. */
export async function handleSnsRequest(body: string): Promise<{ status: 200 | 400 | 403; message: string }> {
  let message: SnsMessage;
  try {
    message = JSON.parse(body) as SnsMessage;
  } catch {
    return { status: 400, message: 'Invalid JSON' };
  }
  if (!message.Type || !message.Signature) return { status: 400, message: 'Not an SNS message' };
  if (config.sesSnsTopicArn && message.TopicArn !== config.sesSnsTopicArn) return { status: 403, message: 'Unexpected topic' };
  if (!(await verifySignature(message))) return { status: 403, message: 'Invalid signature' };

  if (message.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(message.SubscribeURL, false)) return { status: 400, message: 'Untrusted SubscribeURL' };
    await fetch(message.SubscribeURL as string, { signal: AbortSignal.timeout(5000) });
    console.log(`[ses] Confirmed SNS subscription for ${message.TopicArn}`);
    return { status: 200, message: 'Subscription confirmed' };
  }
  if (message.Type === 'Notification') handleSesEvent(JSON.parse(message.Message) as SesEvent);
  return { status: 200, message: 'OK' };
}

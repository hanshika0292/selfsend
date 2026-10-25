import { parseJson } from './util.ts';

export type ApiKeyRow = {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  permission: 'full_access' | 'sending_access';
  domain_id: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type DomainRecord = {
  record: 'SPF' | 'DKIM' | 'DMARC';
  name: string;
  type: 'MX' | 'TXT' | 'CNAME';
  value: string;
  ttl: string;
  status: 'pending' | 'verified' | 'failed' | 'temporary_failure' | 'not_started';
  priority?: number;
};

export type DomainRow = {
  id: string;
  name: string;
  status: 'pending' | 'verified' | 'failed' | 'not_started' | 'partially_verified' | 'partially_failed';
  region: string;
  return_path: string;
  open_tracking: number;
  click_tracking: number;
  records: string;
  created_at: string;
};

export type EmailStatus = 'queued' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'canceled' | 'suppressed';

export type StoredAttachment = {
  filename?: string;
  content?: string;
  path?: string;
  content_type?: string;
  content_id?: string;
};

export type EmailRow = {
  id: string;
  from_addr: string;
  to_addrs: string;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  headers: string | null;
  tags: string | null;
  attachments: string | null;
  broadcast_id: string | null;
  status: EmailStatus;
  last_event: string;
  scheduled_at: string | null;
  send_after: string;
  attempts: number;
  error: string | null;
  message_id: string | null;
  provider_id: string | null;
  recipients: number;
  created_at: string;
  sent_at: string | null;
};

export type ContactRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: number;
  properties: string;
  created_at: string;
};

export type SegmentRow = { id: string; name: string; created_at: string };

export type BroadcastRow = {
  id: string;
  name: string | null;
  segment_id: string | null;
  from_addr: string | null;
  subject: string | null;
  reply_to: string | null;
  preview_text: string | null;
  html: string | null;
  text: string | null;
  status: 'draft' | 'queued' | 'sent';
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
};

export type WebhookRow = {
  id: string;
  endpoint: string;
  events: string;
  secret: string;
  status: 'enabled' | 'disabled';
  created_at: string;
};

export type Tag = { name: string; value: string };

const nullableList = (value: string | null) => (value ? parseJson<string[]>(value, []) : null);

export function serializeEmail(row: EmailRow, full = true) {
  const base = {
    id: row.id,
    to: parseJson<string[]>(row.to_addrs, []),
    from: row.from_addr,
    created_at: row.created_at,
    subject: row.subject,
    bcc: nullableList(row.bcc),
    cc: nullableList(row.cc),
    reply_to: nullableList(row.reply_to),
    last_event: row.last_event,
    scheduled_at: row.scheduled_at,
    message_id: row.message_id,
  };
  if (!full) return base;
  return {
    object: 'email' as const,
    ...base,
    html: row.html,
    text: row.text,
    tags: parseJson<Tag[]>(row.tags, []),
  };
}

export function serializeDomain(row: DomainRow, withRecords: boolean) {
  const base = {
    object: 'domain' as const,
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    region: row.region,
    open_tracking: row.open_tracking === 1,
    click_tracking: row.click_tracking === 1,
    capabilities: { sending: 'enabled', receiving: 'disabled' },
  };
  return withRecords ? { ...base, records: parseJson<DomainRecord[]>(row.records, []) } : base;
}

export function serializeContact(row: ContactRow) {
  return {
    object: 'contact' as const,
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    created_at: row.created_at,
    unsubscribed: row.unsubscribed === 1,
    properties: parseJson<Record<string, unknown>>(row.properties, {}),
  };
}

export function serializeBroadcast(row: BroadcastRow) {
  return {
    object: 'broadcast' as const,
    id: row.id,
    name: row.name,
    segment_id: row.segment_id,
    audience_id: row.segment_id,
    from: row.from_addr,
    subject: row.subject,
    reply_to: nullableList(row.reply_to),
    preview_text: row.preview_text,
    status: row.status,
    created_at: row.created_at,
    scheduled_at: row.scheduled_at,
    sent_at: row.sent_at,
    html: row.html,
    text: row.text,
  };
}

export function serializeWebhook(row: WebhookRow, includeSecret: boolean) {
  return {
    object: 'webhook' as const,
    id: row.id,
    endpoint: row.endpoint,
    created_at: row.created_at,
    status: row.status,
    events: parseJson<string[]>(row.events, []),
    ...(includeSecret ? { signing_secret: row.secret } : {}),
  };
}

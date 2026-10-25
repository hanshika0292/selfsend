import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config.ts';

export const sesClient = config.transport === 'ses' ? new SESv2Client({ region: config.awsRegion }) : null;

function createTransporter(): Transporter {
  switch (config.transport) {
    case 'ses':
      return nodemailer.createTransport({ SES: { sesClient, SendEmailCommand } } as never);
    case 'smtp':
      return nodemailer.createTransport(config.smtpUrl, { pool: true, maxConnections: 3 } as never);
    case 'log':
      return nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  }
}

const transporter = createTransporter();
const outboxDir = config.databasePath === ':memory:' ? null : join(dirname(config.databasePath), 'outbox');

export type SendOptions = SendMailOptions & {
  ses?: { ConfigurationSetName?: string; EmailTags?: { Name: string; Value: string }[] };
};

export type SendResult = { providerId: string; messageId: string };

export async function sendMail(options: SendOptions, emailId: string): Promise<SendResult> {
  const info = await transporter.sendMail(options);
  if (config.transport === 'log') {
    // Dev mode: nothing leaves the machine. Keep the rendered MIME so it can be inspected.
    if (outboxDir) {
      mkdirSync(outboxDir, { recursive: true });
      writeFileSync(join(outboxDir, `${emailId}.eml`), info.message as Buffer);
    }
    console.log(`[mail:log] ${String(options.from)} -> ${String(options.to)} "${String(options.subject)}"`);
  }
  // The SES transport puts SES's MessageId in `response`; SES events reference that id.
  const providerId = config.transport === 'ses' ? String(info.response) : String(info.messageId);
  return { providerId, messageId: String(info.messageId) };
}

type ProviderError = { name?: string; code?: string; responseCode?: number };

const PERMANENT_SES_ERRORS = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'BadRequestException',
  'NotFoundException',
]);

/** Throttling, quota and network errors are retried; rejected content and SMTP 5xx are not. */
export function isRetryable(err: unknown): boolean {
  const e = (err ?? {}) as ProviderError;
  if (typeof e.responseCode === 'number') return e.responseCode < 500;
  if (e.name && PERMANENT_SES_ERRORS.has(e.name)) return false;
  return true;
}

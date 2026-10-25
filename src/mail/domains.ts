import { resolveTxt } from 'node:dns/promises';
import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from '@aws-sdk/client-sesv2';
import { config } from '../config.ts';
import type { DomainRecord, DomainRow } from '../models.ts';
import { sesClient } from './transport.ts';

type RecordStatus = DomainRecord['status'];
type DomainState = { status: DomainRow['status']; records: DomainRecord[] };

/** Statuses in which SES will sign and send for the domain (DKIM verified; MAIL FROM falls back to amazonses.com). */
export const SENDABLE_STATUSES = new Set<DomainRow['status']>(['verified', 'partially_verified', 'partially_failed']);

const SES_STATUS: Record<string, RecordStatus> = {
  SUCCESS: 'verified',
  PENDING: 'pending',
  FAILED: 'failed',
  TEMPORARY_FAILURE: 'temporary_failure',
  NOT_STARTED: 'not_started',
};

async function dmarcRecord(name: string): Promise<DomainRecord> {
  let found = false;
  try {
    const txt = await resolveTxt(`_dmarc.${name}`);
    found = txt.some((chunks) => chunks.join('').toUpperCase().startsWith('V=DMARC1'));
  } catch {
    found = false;
  }
  return { record: 'DMARC', name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none;', ttl: 'Auto', status: found ? 'verified' : 'not_started' };
}

export async function provisionDomain(name: string, returnPath: string): Promise<DomainState> {
  if (!sesClient) return { status: 'not_started', records: [await dmarcRecord(name)] };
  try {
    await sesClient.send(
      new CreateEmailIdentityCommand({ EmailIdentity: name, ConfigurationSetName: config.sesConfigurationSet || undefined }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'AlreadyExistsException') throw err;
  }
  await sesClient.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: name,
      MailFromDomain: `${returnPath}.${name}`,
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    }),
  );
  return inspectDomain(name, returnPath);
}

/**
 * With SES, DNS records and their status come from the SES identity (Easy DKIM + custom MAIL FROM).
 * With SMTP/log transports the provider owns authentication, so the domain is marked verified on request.
 */
export async function inspectDomain(name: string, returnPath: string): Promise<DomainState> {
  if (!sesClient) return { status: 'verified', records: [await dmarcRecord(name)] };

  const identity = await sesClient.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
  const dkim = SES_STATUS[identity.DkimAttributes?.Status ?? ''] ?? 'not_started';
  const mailFrom = SES_STATUS[identity.MailFromAttributes?.MailFromDomainStatus ?? ''] ?? 'not_started';

  const records: DomainRecord[] = [
    ...(identity.DkimAttributes?.Tokens ?? []).map(
      (token): DomainRecord => ({
        record: 'DKIM',
        name: `${token}._domainkey`,
        type: 'CNAME',
        value: `${token}.dkim.amazonses.com`,
        ttl: 'Auto',
        status: dkim,
      }),
    ),
    {
      record: 'SPF',
      name: returnPath,
      type: 'MX',
      value: `feedback-smtp.${config.awsRegion}.amazonses.com`,
      priority: 10,
      ttl: 'Auto',
      status: mailFrom,
    },
    { record: 'SPF', name: returnPath, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: mailFrom },
    await dmarcRecord(name),
  ];

  let status: DomainRow['status'];
  if (dkim === 'verified') {
    status = mailFrom === 'verified' ? 'verified' : mailFrom === 'failed' ? 'partially_failed' : 'partially_verified';
  } else if (dkim === 'failed') status = 'failed';
  else if (dkim === 'not_started') status = 'not_started';
  else status = 'pending';

  return { status, records };
}

export async function deprovisionDomain(name: string): Promise<void> {
  if (!sesClient) return;
  try {
    await sesClient.send(new DeleteEmailIdentityCommand({ EmailIdentity: name }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'NotFoundException') throw err;
  }
}

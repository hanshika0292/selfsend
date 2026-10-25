export type TransportKind = 'ses' | 'smtp' | 'log';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

const port = num('PORT', 3000);
const transport = (process.env.MAIL_TRANSPORT ?? 'log') as TransportKind;
if (!['ses', 'smtp', 'log'].includes(transport)) {
  throw new Error(`MAIL_TRANSPORT must be one of ses | smtp | log, got "${transport}"`);
}
if (transport === 'smtp' && !process.env.SMTP_URL) {
  throw new Error('MAIL_TRANSPORT=smtp requires SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465)');
}

export const config = {
  port,
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
  databasePath: process.env.DATABASE_PATH ?? './data/selfsend.db',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  transport,
  smtpUrl: process.env.SMTP_URL ?? '',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  sesConfigurationSet: process.env.SES_CONFIGURATION_SET ?? '',
  /** When set, SNS messages from any other topic are rejected. */
  sesSnsTopicArn: process.env.SES_SNS_TOPIC_ARN ?? '',
  sendRatePerSecond: Math.max(1, num('SEND_RATE_PER_SECOND', 10)),
  maxSendAttempts: Math.max(1, num('MAX_SEND_ATTEMPTS', 5)),
  requireVerifiedDomain: process.env.REQUIRE_VERIFIED_DOMAIN !== 'false',
  /** Postal address appended to broadcast footers (CAN-SPAM requires one for marketing mail). */
  companyAddress: process.env.COMPANY_ADDRESS ?? '',
  /** Used only for the cost estimate on the dashboard. */
  pricePer1000: num('SES_PRICE_PER_1000', 0.1),
  fixedMonthlyCost: num('FIXED_MONTHLY_COST', 6),
};

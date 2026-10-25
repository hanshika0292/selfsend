import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { CreateTopicCommand, SNSClient, SetTopicAttributesCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { createApiKey } from './api/api-keys.ts';
import { config } from './config.ts';
import { db } from './db.ts';

const [command, ...args] = process.argv.slice(2);

function ignoreExists(err: unknown): void {
  if ((err as { name?: string }).name !== 'AlreadyExistsException') throw err;
}

/** One-time AWS wiring: configuration set -> SNS topic -> HTTPS subscription to /hooks/ses. */
async function setupSes(): Promise<void> {
  const name = config.sesConfigurationSet || 'selfsend';
  if (!config.publicUrl.startsWith('https://')) {
    throw new Error(`PUBLIC_URL must be an https URL reachable by AWS SNS (got ${config.publicUrl}).`);
  }
  const ses = new SESv2Client({ region: config.awsRegion });
  const sns = new SNSClient({ region: config.awsRegion });

  await ses.send(new CreateConfigurationSetCommand({ ConfigurationSetName: name })).catch(ignoreExists);
  console.log(`✓ configuration set "${name}"`);

  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `${name}-events`, Attributes: { SignatureVersion: '2' } }));
  if (!TopicArn) throw new Error('SNS did not return a topic ARN');
  const account = TopicArn.split(':')[4];
  await sns.send(
    new SetTopicAttributesCommand({
      TopicArn,
      AttributeName: 'Policy',
      AttributeValue: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ses.amazonaws.com' },
            Action: 'sns:Publish',
            Resource: TopicArn,
            Condition: { StringEquals: { 'aws:SourceAccount': account } },
          },
        ],
      }),
    }),
  );
  console.log(`✓ SNS topic ${TopicArn}`);

  await ses
    .send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestinationName: 'selfsend-sns',
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'DELIVERY_DELAY', 'RENDERING_FAILURE'],
          SnsDestination: { TopicArn },
        },
      }),
    )
    .catch(ignoreExists);
  console.log('✓ event destination (delivery, bounce, complaint, reject, delay)');

  await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'https', Endpoint: `${config.publicUrl}/hooks/ses` }));
  console.log(`✓ subscribed ${config.publicUrl}/hooks/ses (the running server confirms it automatically)`);
  console.log(`\nAdd to your environment and restart:\n  SES_CONFIGURATION_SET=${name}\n  SES_SNS_TOPIC_ARN=${TopicArn}`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'create-key': {
      const { token } = createApiKey({ name: args[0] ?? 'cli' });
      console.log(token);
      break;
    }
    case 'setup-ses':
      await setupSes();
      break;
    case 'backup': {
      const target = args[0] ?? `./data/backup-${new Date().toISOString().slice(0, 10)}.db`;
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      console.log(`Backup written to ${target}`);
      break;
    }
    default:
      console.log(`Usage: npm run cli -- <command>

  create-key [name]   Create a full-access API key and print it
  setup-ses           Create the SES configuration set + SNS topic and subscribe PUBLIC_URL/hooks/ses
  backup [path]       Write a consistent SQLite snapshot (safe while the server runs)`);
      process.exitCode = command ? 1 : 0;
  }
}

await main();

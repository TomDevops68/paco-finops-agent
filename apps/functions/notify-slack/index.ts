import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DynamoSlackThreadRegistry,
  CachedSecretReader,
} from '../../../packages/aws-repositories/src/index.js';
import { SlackWebApiClient } from '../../../packages/slack-connector/src/index.js';
import type { FinalCostAnalysis } from '../../../packages/schemas/src/index.js';
import { notifySlack, type NotifyInput, type ReportCompleteLine } from './handler.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const threads = new DynamoSlackThreadRegistry(ddb, mustEnv('CONTROL_TABLE'));
const secrets = new CachedSecretReader(new SecretsManagerClient({}));
const slackSecretArn = mustEnv('SLACK_SECRET_ARN');
const channel = mustEnv('SLACK_CHANNEL_ID');
const analysisCacheTable = mustEnv('ANALYSIS_CACHE_TABLE');

// Reads a completed line's validated analysis back from where persist-result
// already wrote it — keeps the DynamoDB batch item itself small (labels/
// fingerprints/status only) instead of threading the full FinalCostAnalysis
// payload through the fan-in record.
async function getPriorAnalysis(lineFingerprint: string): Promise<FinalCostAnalysis | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: analysisCacheTable,
      Key: { lineFingerprint },
      ConsistentRead: true,
    }),
  );
  const record = result.Item as { value?: FinalCostAnalysis } | undefined;
  return record?.value;
}

let cachedSlack: Promise<SlackWebApiClient> | undefined;
function getSlackClient(): Promise<SlackWebApiClient> {
  cachedSlack ??= secrets
    .getSecretString(slackSecretArn)
    .then((botToken) => new SlackWebApiClient({ botToken }));
  return cachedSlack;
}

type SupervisorInput = NotifyInput;

async function enrichLine(line: ReportCompleteLine): Promise<ReportCompleteLine> {
  if (line.status !== 'completed') return line;
  const analysis = await getPriorAnalysis(line.lineFingerprint);
  const enriched: ReportCompleteLine & { status: 'completed' } = {
    lineLabel: line.lineLabel,
    lineFingerprint: line.lineFingerprint,
    status: 'completed',
  };
  if (analysis) enriched.analysis = analysis;
  if (line.trendDirection) enriched.trendDirection = line.trendDirection;
  return enriched;
}

async function buildNotifyInput(event: SupervisorInput): Promise<NotifyInput> {
  if (event.kind !== 'report_complete') return event;
  const lines = await Promise.all(event.lines.map((line) => enrichLine(line)));
  return { ...event, lines };
}

export async function handler(event: SupervisorInput) {
  const slack = await getSlackClient();
  return notifySlack({ ...(await buildNotifyInput(event)), channel }, threads, slack);
}

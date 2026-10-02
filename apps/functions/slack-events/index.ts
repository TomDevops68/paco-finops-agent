import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DynamoRepositories,
  DynamoConcurrencyLimiter,
  DynamoSlackThreadRegistry,
  DynamoBatchTracker,
  SqsInvestigationPublisher,
  CachedSecretReader,
  readYamlFromS3,
  type AsyncInvestigationLock,
} from '../../../packages/aws-repositories/src/index.js';
import { AccountMapConfigSchema } from '../../../packages/config/src/index.js';
import { SlackWebApiClient } from '../../../packages/slack-connector/src/index.js';
import type { FinalCostAnalysis } from '../../../packages/schemas/src/index.js';
import { handleSlackEvent } from './handler.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const s3 = new S3Client({});
const secrets = new CachedSecretReader(new SecretsManagerClient({}));

const tables = {
  costReports: mustEnv('COST_REPORTS_TABLE'),
  control: mustEnv('CONTROL_TABLE'),
  analysisCache: mustEnv('ANALYSIS_CACHE_TABLE'),
};

const repositories = new DynamoRepositories<FinalCostAnalysis>(ddb, tables);
const concurrencyLimiter = new DynamoConcurrencyLimiter(ddb, tables.control);
const queue = new SqsInvestigationPublisher(sqs, mustEnv('INVESTIGATION_QUEUE_URL'));
const threads = new DynamoSlackThreadRegistry(ddb, tables.control);
const batches = new DynamoBatchTracker(ddb, tables.control);

const locks: AsyncInvestigationLock = {
  tryAcquire: (lineFingerprint, ownerToken, ttlMs, nowMs) =>
    repositories.tryAcquireLock(lineFingerprint, ownerToken, ttlMs, nowMs),
  release: (lineFingerprint, ownerToken) => repositories.releaseLock(lineFingerprint, ownerToken),
};

const slackSecretArn = mustEnv('SLACK_SECRET_ARN');
const slackSigningSecretArn = mustEnv('SLACK_SIGNING_SECRET_ARN');
const configBucket = mustEnv('CONFIG_BUCKET');

const lockTtlMs = Number(mustEnv('LOCK_TTL_MS'));
const batchTtlMs = Number(mustEnv('BATCH_TTL_MS'));
const concurrencyBudget = {
  limiter: concurrencyLimiter,
  maxGlobalInvestigations: Number(mustEnv('MAX_GLOBAL_INVESTIGATIONS')),
  maxPerReportInvestigations: Number(mustEnv('MAX_PER_REPORT_INVESTIGATIONS')),
};
const thresholds = {
  significantChangePercent: Number(mustEnv('SIGNIFICANT_CHANGE_PERCENT')),
  excludedLabels: JSON.parse(mustEnv('EXCLUDED_LABELS_JSON')) as string[],
};

let cachedSlackClient: Promise<SlackWebApiClient> | undefined;
function getSlackClient(): Promise<SlackWebApiClient> {
  cachedSlackClient ??= secrets
    .getSecretString(slackSecretArn)
    .then((botToken) => new SlackWebApiClient({ botToken }));
  return cachedSlackClient;
}

let cachedAccountMap: Promise<Record<string, string>> | undefined;
function getAccountMap(): Promise<Record<string, string>> {
  cachedAccountMap ??= readYamlFromS3(s3, configBucket, 'account-map.yaml').then(
    (raw) => AccountMapConfigSchema.parse(raw).accounts,
  );
  return cachedAccountMap;
}

interface ApiGatewayProxyEvent {
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface ApiGatewayProxyResult {
  statusCode: number;
  body: string;
}

function rawBody(event: ApiGatewayProxyEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/**
 * Real AWS entrypoint for the Slack Events API webhook (API Gateway Lambda
 * proxy integration). Every application decision lives in handleSlackEvent;
 * this only wires real AWS/Slack clients and adapts the proxy event shape —
 * same split as paco-troubleshoot-agent's slack-events `index.ts`/`handler.ts`.
 */
export async function handler(event: ApiGatewayProxyEvent): Promise<ApiGatewayProxyResult> {
  const [slack, signingSecret, accountMap] = await Promise.all([
    getSlackClient(),
    secrets.getSecretString(slackSigningSecretArn),
    getAccountMap(),
  ]);

  return handleSlackEvent({
    headers: event.headers ?? {},
    rawBody: rawBody(event),
    signingSecret,
    slack,
    accountMap,
    thresholds,
    reports: repositories,
    threads,
    locks,
    concurrency: concurrencyBudget,
    queue,
    batches,
    lockTtlMs,
    batchTtlMs,
  });
}

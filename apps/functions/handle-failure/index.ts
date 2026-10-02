import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DynamoRepositories,
  DynamoConcurrencyLimiter,
  DynamoBatchTracker,
} from '../../../packages/aws-repositories/src/index.js';
import { handleFailure, type HandleFailureInput } from './handler.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const controlTable = mustEnv('CONTROL_TABLE');
const repositories = new DynamoRepositories(ddb, {
  costReports: mustEnv('COST_REPORTS_TABLE'),
  control: controlTable,
  analysisCache: mustEnv('ANALYSIS_CACHE_TABLE'),
});
const concurrencyLimiter = new DynamoConcurrencyLimiter(ddb, controlTable);
const batches = new DynamoBatchTracker(ddb, controlTable);

export async function handler(event: HandleFailureInput) {
  return handleFailure(event, repositories, concurrencyLimiter, batches);
}

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import {
  DynamoRepositories,
  readYamlFromS3,
} from '../../../packages/aws-repositories/src/index.js';
import { PlaybooksConfigSchema } from '../../../packages/config/src/index.js';
import { resolveContext, type CostReportReader, type ResolveContextInput } from './handler.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const repositories = new DynamoRepositories(ddb, {
  costReports: mustEnv('COST_REPORTS_TABLE'),
  control: mustEnv('CONTROL_TABLE'),
  analysisCache: mustEnv('ANALYSIS_CACHE_TABLE'),
});
const configBucket = mustEnv('CONFIG_BUCKET');

const reports: CostReportReader = {
  getReport: async (reportDate) => {
    const record = await repositories.getReport(reportDate);
    return record ? { report: record.report } : undefined;
  },
};

export async function handler(event: ResolveContextInput) {
  const playbooksConfig = PlaybooksConfigSchema.parse(
    await readYamlFromS3(s3, configBucket, 'playbooks.yaml'),
  );
  return resolveContext(event, reports, playbooksConfig);
}

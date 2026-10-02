import { S3Client } from '@aws-sdk/client-s3';
import { S3WorkerResultStore } from '../../../packages/aws-repositories/src/index.js';
import { validateAnalysis, type ValidateAnalysisInput } from './handler.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

const resultStore = new S3WorkerResultStore(new S3Client({}), mustEnv('EVIDENCE_BUCKET'));
const minimumConfidence = Number(mustEnv('MINIMUM_CONFIDENCE_FOR_LIKELY_DRIVER_IDENTIFIED'));
const minimumEvidenceTypes = Number(mustEnv('MINIMUM_EVIDENCE_TYPES_FOR_LIKELY_DRIVER_IDENTIFIED'));

export async function handler(event: ValidateAnalysisInput) {
  const workerResult = await resultStore.get(event.resultKey);
  return validateAnalysis(event, workerResult, { minimumConfidence, minimumEvidenceTypes });
}

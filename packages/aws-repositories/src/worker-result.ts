import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { WorkerResult, WorkerResultStore } from '../../agent-sdk-runtime/src/worker.js';

export interface S3WorkerResultCommandClient {
  send(command: unknown): Promise<unknown>;
}

interface WorkerResultManifest {
  status: string;
  checksum: string;
  result: WorkerResult;
}

function checksumOf(result: WorkerResult): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

/**
 * Ported from paco-troubleshoot-agent's `S3WorkerResultStore` (ADR-0004's
 * persisted-result protocol): the worker writes a versioned, checksummed
 * manifest and commits it as `READY`. A read that finds anything short of a
 * `READY`, checksum-matching manifest is treated as "not completed."
 */
export class S3WorkerResultStore implements WorkerResultStore {
  public constructor(
    private readonly client: S3WorkerResultCommandClient,
    private readonly bucket: string,
  ) {}

  public async put(key: string, result: WorkerResult): Promise<void> {
    const manifest: WorkerResultManifest = {
      status: 'READY' satisfies WorkerResultManifest['status'],
      checksum: checksumOf(result),
      result,
    };
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(manifest),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  public async get(key: string): Promise<WorkerResult | undefined> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        Body?: { transformToString?: () => Promise<string> };
      };
      if (!response.Body?.transformToString) return undefined;
      const manifest = JSON.parse(await response.Body.transformToString()) as WorkerResultManifest;
      if (manifest.status !== 'READY') return undefined;
      if (checksumOf(manifest.result) !== manifest.checksum)
        throw new Error('WORKER_RESULT_CHECKSUM_MISMATCH');
      return manifest.result;
    } catch (error) {
      if (error instanceof Error && /NoSuchKey|NotFound|404/.test(error.name + error.message))
        return undefined;
      throw error;
    }
  }
}

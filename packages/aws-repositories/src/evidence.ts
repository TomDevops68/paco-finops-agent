import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { CostEvidenceRecordSchema, type CostEvidenceRecord } from '../../schemas/src/index.js';
import { redactText, redactUnknown } from '../../core/src/redaction.js';

export interface S3EvidenceCommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface EvidencePackage {
  type: CostEvidenceRecord['type'];
  summary: string;
  data: unknown;
  collectedAt: string;
  storageKey: string;
  metadata?: Record<string, unknown>;
}

/** Adapted from paco-troubleshoot-agent's `S3EvidenceCatalog` — renamed for cost evidence types, otherwise unchanged. */
export class S3EvidenceCatalog {
  public constructor(
    private readonly client: S3EvidenceCommandClient,
    private readonly bucket: string,
  ) {}

  public async persist(input: EvidencePackage): Promise<CostEvidenceRecord> {
    const data = redactUnknown(input.data);
    const summary = redactText(input.summary).slice(0, 2_000);
    const digest = createHash('sha256')
      .update(JSON.stringify({ type: input.type, summary, data, storageKey: input.storageKey }))
      .digest('hex')
      .slice(0, 24);
    const id = `EV-${digest}`;
    const record = CostEvidenceRecordSchema.parse({
      id,
      type: input.type,
      summary,
      collectedAt: input.collectedAt,
      storageKey: input.storageKey,
      metadata: redactUnknown(input.metadata ?? {}),
    });
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.storageKey,
        Body: JSON.stringify({ record, data }),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }),
    );
    return record;
  }

  public async saveRecords(
    storageKey: string,
    records: readonly CostEvidenceRecord[],
  ): Promise<void> {
    const validated = records.map((record) => CostEvidenceRecordSchema.parse(record));
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: JSON.stringify(validated),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  public async loadRecords(storageKey: string): Promise<CostEvidenceRecord[]> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      )) as {
        Body?: { transformToString?: () => Promise<string> };
      };
      if (!response.Body?.transformToString) return [];
      const value = JSON.parse(await response.Body.transformToString()) as unknown;
      return CostEvidenceRecordSchema.array().parse(value);
    } catch (error) {
      const details = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (details.name === 'NoSuchKey' || details.$metadata?.httpStatusCode === 404) return [];
      throw error;
    }
  }
}

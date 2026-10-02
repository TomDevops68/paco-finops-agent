import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { NormalizedCostReport } from '../../schemas/src/index.js';

export interface DynamoCommandClient {
  send(
    command: unknown,
  ): Promise<{ Item?: Record<string, unknown>; Attributes?: Record<string, unknown> }>;
}

export interface CostReportRecord {
  reportDate: string;
  report: NormalizedCostReport;
  slackChannel: string;
  slackThreadTs: string;
  ownMessageTs?: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
  expiresAt: number;
}

export interface UpsertReportInput {
  report: NormalizedCostReport;
  sourceEventId: string;
  timestamp: string;
  slackChannel: string;
  slackThreadTs: string;
}

/**
 * The most recent analysis produced for a line — read back by the worker as
 * evidence for its own next investigation of that same line ("you looked at
 * this before, here's what you found"), never as a reason to skip
 * investigating. `expiresAt` only controls DynamoDB TTL cleanup of stale
 * memory, not whether this record is used.
 */
export interface PriorAnalysisRecord<T> {
  lineFingerprint: string;
  value: T;
  createdAt: string;
  expiresAt: string;
}

export interface LockRecord {
  controlKey: string;
  ownerToken: string;
  expiresAt: number;
}

interface RepositoryTables {
  costReports: string;
  control: string;
  analysisCache: string;
}

/**
 * Adapted from paco-troubleshoot-agent's `DynamoRepositories`
 * (packages/aws-repositories/src/dynamodb.ts) — same conditional-write
 * idempotency and lock/cache idioms, simplified for a domain without
 * occurrence-counting or a two-stage fingerprint+deployment identity (see
 * `packages/core/src/cost-orchestration.ts`'s comment).
 */
export class DynamoRepositories<T> {
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly tables: RepositoryTables,
  ) {}

  async upsertReport(
    input: UpsertReportInput,
  ): Promise<{ duplicate: boolean; record: CostReportRecord }> {
    const sourceKey = `IDEMPOTENCY#slack:${input.sourceEventId}`;
    const now = input.timestamp;
    const command = new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.tables.control,
            Item: {
              controlKey: sourceKey,
              expiresAt: Math.floor(Date.parse(now) / 1_000),
              createdAt: now,
            },
            ConditionExpression: 'attribute_not_exists(controlKey)',
          },
        },
        {
          Update: {
            TableName: this.tables.costReports,
            Key: { reportDate: input.report.reportDate },
            UpdateExpression:
              'SET report = if_not_exists(report, :report), slackChannel = if_not_exists(slackChannel, :channel), slackThreadTs = if_not_exists(slackThreadTs, :threadTs), firstSeen = if_not_exists(firstSeen, :now), lastSeen = :now ADD mentionCount :one',
            ExpressionAttributeValues: {
              ':report': input.report,
              ':channel': input.slackChannel,
              ':threadTs': input.slackThreadTs,
              ':now': now,
              ':one': 1,
            },
          },
        },
      ],
    });
    try {
      await this.client.send(command);
    } catch (error) {
      // TransactWriteCommand throws TransactionCanceledException, not
      // ConditionalCheckFailedException directly — see
      // paco-troubleshoot-agent's `upsertOccurrence` comment (caught live,
      // 2026-09-24) for why both must be checked.
      const isDuplicateConditionFailure =
        error instanceof ConditionalCheckFailedException ||
        (error instanceof TransactionCanceledException &&
          error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed'));
      if (isDuplicateConditionFailure) {
        const record = await this.getReport(input.report.reportDate);
        if (record) return { duplicate: true, record };
      }
      throw error;
    }
    const record = await this.getReport(input.report.reportDate);
    if (!record) throw new Error('COST_REPORT_WRITE_NOT_VISIBLE');
    return { duplicate: false, record };
  }

  async getReport(reportDate: string): Promise<CostReportRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tables.costReports,
        Key: { reportDate },
        ConsistentRead: true,
      }),
    );
    return result.Item as CostReportRecord | undefined;
  }

  async recordOwnMessage(reportDate: string, ownMessageTs: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tables.costReports,
        Key: { reportDate },
        UpdateExpression: 'SET ownMessageTs = :ts',
        ExpressionAttributeValues: { ':ts': ownMessageTs },
      }),
    );
  }

  async getPriorAnalysis(lineFingerprint: string): Promise<PriorAnalysisRecord<T> | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tables.analysisCache,
        Key: { lineFingerprint },
        ConsistentRead: true,
      }),
    );
    return result.Item as PriorAnalysisRecord<T> | undefined;
  }

  /** Always overwrites — this is a "last investigation of this line" memory slot, not a once-only cache write. */
  async putPriorAnalysis(record: PriorAnalysisRecord<T>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tables.analysisCache, Item: record }));
  }

  async tryAcquireLock(
    lineFingerprint: string,
    ownerToken: string,
    ttlMs: number,
    nowMs = Date.now(),
  ): Promise<boolean> {
    const expiresAt = Math.floor((nowMs + ttlMs) / 1_000);
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tables.control,
          Key: { controlKey: `LOCK#${lineFingerprint}` },
          UpdateExpression: 'SET ownerToken = :owner, expiresAt = :expires',
          ConditionExpression:
            'attribute_not_exists(controlKey) OR expiresAt <= :now OR ownerToken = :owner',
          ExpressionAttributeValues: {
            ':owner': ownerToken,
            ':expires': expiresAt,
            ':now': Math.floor(nowMs / 1_000),
          },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  async releaseLock(lineFingerprint: string, ownerToken: string): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tables.control,
          Key: { controlKey: `LOCK#${lineFingerprint}` },
          UpdateExpression: 'REMOVE ownerToken SET releasedAt = :now',
          ConditionExpression: 'ownerToken = :owner',
          ExpressionAttributeValues: { ':owner': ownerToken, ':now': new Date().toISOString() },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  async getLock(lineFingerprint: string, nowMs = Date.now()): Promise<LockRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tables.control,
        Key: { controlKey: `LOCK#${lineFingerprint}` },
        ConsistentRead: true,
      }),
    );
    const record = result.Item as LockRecord | undefined;
    return record && record.expiresAt > nowMs ? record : undefined;
  }
}

/** Ported from paco-troubleshoot-agent's `DynamoConcurrencyLimiter` — a String Set of owner tokens per scope. */
export class DynamoConcurrencyLimiter {
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly controlTable: string,
  ) {}

  async tryReserve(scopeKey: string, ownerToken: string, max: number): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.controlTable,
          Key: { controlKey: `CONC#${scopeKey}` },
          UpdateExpression: 'ADD owners :ownerSet',
          ConditionExpression:
            'attribute_not_exists(owners) OR size(owners) < :max OR contains(owners, :owner)',
          ExpressionAttributeValues: {
            ':ownerSet': new Set([ownerToken]),
            ':max': max,
            ':owner': ownerToken,
          },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  async release(scopeKey: string, ownerToken: string): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.controlTable,
          Key: { controlKey: `CONC#${scopeKey}` },
          UpdateExpression: 'DELETE owners :ownerSet',
          ConditionExpression: 'attribute_exists(controlKey)',
          ExpressionAttributeValues: { ':ownerSet': new Set([ownerToken]) },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }
}

/** Claims the single Slack thread that owns a report date; only the first caller may create it. */
export class DynamoSlackThreadRegistry {
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly controlTable: string,
  ) {}

  async claimThread(reportDate: string, threadTs: string): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.controlTable,
          Item: { controlKey: `SLACK#${reportDate}`, threadTs },
          ConditionExpression: 'attribute_not_exists(controlKey)',
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  async getThread(reportDate: string): Promise<{ threadTs: string } | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.controlTable,
        Key: { controlKey: `SLACK#${reportDate}` },
        ConsistentRead: true,
      }),
    );
    const item = result.Item as { threadTs?: string } | undefined;
    return item?.threadTs ? { threadTs: item.threadTs } : undefined;
  }
}

export interface BatchLineResult {
  lineLabel: string;
  lineFingerprint: string;
  status: 'completed' | 'failed';
  reason?: string;
  /** The report line's own deterministic trend direction, known regardless of investigation outcome — used to pick an up/down icon in the Slack message. */
  trendDirection?: 'up' | 'down' | 'flat' | 'new';
}

export interface BatchRecord {
  expectedCount: number;
  completedCount: number;
  results: BatchLineResult[];
}

export interface BatchContribution {
  /** True iff this call's own atomic update brought completedCount to expectedCount — i.e. this caller is the fan-in winner, responsible for the one consolidated notification. */
  isLast: boolean;
  /** Populated only when isLast is true — the full, final set of per-line results to render. */
  batch?: BatchRecord;
}

/**
 * Fan-in for one Slack `@mention` round: N independently-started Step
 * Functions executions (one per enqueued line) each call `contribute` exactly
 * once on their own terminal path (persist-result on success, handle-failure
 * on any failure). DynamoDB serializes concurrent updates to the same item,
 * so exactly one caller's own response ever observes
 * `completedCount === expectedCount` — that caller, and only that caller, is
 * responsible for posting the one consolidated Slack message.
 */
export class DynamoBatchTracker {
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly controlTable: string,
  ) {}

  async createBatch(input: {
    reportDate: string;
    batchId: string;
    expectedCount: number;
    slackChannel: string;
    slackThreadTs: string;
    ttlSeconds: number;
    nowMs?: number;
  }): Promise<void> {
    const now = input.nowMs ?? Date.now();
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.controlTable,
          Item: {
            controlKey: `BATCH#${input.reportDate}#${input.batchId}`,
            expectedCount: input.expectedCount,
            completedCount: 0,
            results: [],
            slackChannel: input.slackChannel,
            slackThreadTs: input.slackThreadTs,
            createdAt: new Date(now).toISOString(),
            expiresAt: Math.floor((now + input.ttlSeconds * 1_000) / 1_000),
          },
          ConditionExpression: 'attribute_not_exists(controlKey)',
        }),
      );
    } catch (error) {
      // Redelivered Slack event for the same (reportDate, sourceEventId) —
      // this round's batch already exists; not an error, leave it as-is so
      // the original expectedCount sticks.
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  async contribute(input: {
    reportDate: string;
    batchId: string;
    lineFingerprint: string;
    entry: BatchLineResult;
  }): Promise<BatchContribution> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.controlTable,
          Key: { controlKey: `BATCH#${input.reportDate}#${input.batchId}` },
          UpdateExpression:
            'SET results = list_append(if_not_exists(results, :empty), :entry) ADD completedCount :one, contributedFingerprints :fpSet',
          ConditionExpression:
            'attribute_not_exists(contributedFingerprints) OR NOT contains(contributedFingerprints, :fp)',
          ExpressionAttributeValues: {
            ':empty': [],
            ':entry': [input.entry],
            ':one': 1,
            ':fpSet': new Set([input.lineFingerprint]),
            ':fp': input.lineFingerprint,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      const item = result.Attributes as BatchRecord | undefined;
      if (!item) throw new Error('BATCH_CONTRIBUTE_NOT_VISIBLE');
      const isLast = item.completedCount === item.expectedCount;
      return isLast ? { isLast, batch: item } : { isLast };
    } catch (error) {
      // A redelivered persist-result/handle-failure invocation for a line
      // that already contributed — not an error, and not this caller's job
      // to re-derive "am I last" (the original successful call for this
      // line already made that determination once).
      if (error instanceof ConditionalCheckFailedException) return { isLast: false };
      throw error;
    }
  }
}

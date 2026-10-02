import { costLineFingerprint, deriveCostOwnerToken } from '../../core/src/index.js';
import type {
  CostReportLine,
  CostReportTrend,
  NormalizedCostReport,
} from '../../schemas/src/index.js';
import type { CostReportRecord, UpsertReportInput } from './dynamodb.js';

/**
 * Async, real-AWS-backed counterpart to `packages/core/src/
 * cost-orchestration.ts`'s pure `coordinateCostInvestigation` — same
 * decision logic, `await`-ed against DynamoDB instead of in-memory fakes.
 * Kept as a separate implementation (not a thin async wrapper around the
 * sync one) because the sync core version exists specifically to be
 * fast-testable without AWS; duplicating the ~20 lines of decision logic
 * here is cheaper than reconciling two different calling conventions.
 */
export interface AsyncCostReportRepository {
  upsertReport(input: UpsertReportInput): Promise<{ duplicate: boolean; record: CostReportRecord }>;
}

export interface AsyncInvestigationLock {
  tryAcquire(
    lineFingerprint: string,
    ownerToken: string,
    ttlMs: number,
    nowMs?: number,
  ): Promise<boolean>;
  release(lineFingerprint: string, ownerToken: string): Promise<boolean>;
}

export interface AsyncConcurrencyLimiter {
  tryReserve(scopeKey: string, ownerToken: string, max: number, nowMs?: number): Promise<boolean>;
  release(scopeKey: string, ownerToken: string): Promise<void>;
}

export interface AsyncConcurrencyBudget {
  limiter: AsyncConcurrencyLimiter;
  maxGlobalInvestigations: number;
  maxPerReportInvestigations: number;
}

export interface InvestigationQueuePublisher {
  publish(message: {
    reportDate: string;
    lineFingerprint: string;
    lineLabel: string;
    ownerToken: string;
    slackChannel: string;
    slackThreadTs: string;
    batchId: string;
    expectedCount: number;
    trendDirection: CostReportTrend['direction'];
  }): Promise<void>;
}

export interface AsyncBatchCreator {
  createBatch(input: {
    reportDate: string;
    batchId: string;
    expectedCount: number;
    slackChannel: string;
    slackThreadTs: string;
    ttlSeconds: number;
    nowMs?: number;
  }): Promise<void>;
}

export interface CoordinateAndEnqueueLineResult {
  line: CostReportLine;
  lineFingerprint: string;
  enqueueInvestigation: boolean;
  ownerToken?: string;
  concurrencyThrottled?: boolean;
  lockContended?: boolean;
}

export async function coordinateAndEnqueue(input: {
  report: NormalizedCostReport;
  notableLines: readonly CostReportLine[];
  sourceEventId: string;
  lockTtlMs: number;
  nowMs?: number;
  locks: AsyncInvestigationLock;
  concurrency: AsyncConcurrencyBudget;
  queue: InvestigationQueuePublisher;
  batches: AsyncBatchCreator;
  batchTtlMs: number;
  slackChannel: string;
  slackThreadTs: string;
}): Promise<CoordinateAndEnqueueLineResult[]> {
  const results: CoordinateAndEnqueueLineResult[] = [];
  // --- Pass 1: decide lock/concurrency for every line; nothing published yet. ---
  for (const line of input.notableLines) {
    const lineFingerprint = costLineFingerprint(input.report, line);
    const ownerToken = deriveCostOwnerToken(lineFingerprint, input.sourceEventId);
    const acquired = await input.locks.tryAcquire(
      lineFingerprint,
      ownerToken,
      input.lockTtlMs,
      input.nowMs,
    );
    if (!acquired) {
      results.push({ line, lineFingerprint, enqueueInvestigation: false, lockContended: true });
      continue;
    }

    const scopes = [
      { scopeKey: 'CONC#GLOBAL', max: input.concurrency.maxGlobalInvestigations },
      {
        scopeKey: `CONC#REPORT#${input.report.reportDate}`,
        max: input.concurrency.maxPerReportInvestigations,
      },
    ];
    const reserved: string[] = [];
    let concurrencyThrottled = false;
    for (const scope of scopes) {
      if (
        await input.concurrency.limiter.tryReserve(
          scope.scopeKey,
          ownerToken,
          scope.max,
          input.nowMs,
        )
      ) {
        reserved.push(scope.scopeKey);
      } else {
        concurrencyThrottled = true;
        break;
      }
    }
    if (concurrencyThrottled) {
      for (const scopeKey of reserved)
        await input.concurrency.limiter.release(scopeKey, ownerToken);
      await input.locks.release(lineFingerprint, ownerToken);
      results.push({
        line,
        lineFingerprint,
        enqueueInvestigation: false,
        concurrencyThrottled: true,
      });
      continue;
    }

    results.push({ line, lineFingerprint, ownerToken, enqueueInvestigation: true });
  }

  // --- Pass 2: only lines that actually cleared lock+concurrency this round
  // count toward the batch this round's consolidated message waits on. ---
  const enqueued = results.filter(
    (
      result,
    ): result is CoordinateAndEnqueueLineResult & {
      enqueueInvestigation: true;
      ownerToken: string;
    } => result.enqueueInvestigation,
  );
  if (enqueued.length > 0) {
    const batchId = input.sourceEventId;
    await input.batches.createBatch({
      reportDate: input.report.reportDate,
      batchId,
      expectedCount: enqueued.length,
      slackChannel: input.slackChannel,
      slackThreadTs: input.slackThreadTs,
      ttlSeconds: Math.ceil(input.batchTtlMs / 1_000),
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    });
    for (const result of enqueued) {
      await input.queue.publish({
        reportDate: input.report.reportDate,
        lineFingerprint: result.lineFingerprint,
        lineLabel: result.line.label,
        ownerToken: result.ownerToken,
        slackChannel: input.slackChannel,
        slackThreadTs: input.slackThreadTs,
        batchId,
        expectedCount: enqueued.length,
        trendDirection: result.line.trend.direction,
      });
    }
  }
  return results;
}

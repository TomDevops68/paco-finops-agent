import { costConcurrencyScopeKeys } from '../../../packages/core/src/index.js';
import type { FinalCostAnalysis } from '../../../packages/schemas/src/index.js';

export interface PersistResultInput {
  reportDate: string;
  lineFingerprint: string;
  lineLabel: string;
  ownerToken: string;
  batchId: string;
  expectedCount: number;
  analysis: FinalCostAnalysis;
  memoryRetentionSeconds: number;
  trendDirection?: 'up' | 'down' | 'flat' | 'new';
}

export interface MemoryWriter {
  putPriorAnalysis(record: {
    lineFingerprint: string;
    value: FinalCostAnalysis;
    createdAt: string;
    expiresAt: string;
  }): Promise<void>;
}

export interface LockReleaser {
  releaseLock(lineFingerprint: string, ownerToken: string): Promise<boolean>;
}

export interface ConcurrencyReleaser {
  release(scopeKey: string, ownerToken: string): Promise<void>;
}

export interface BatchLineResult {
  lineLabel: string;
  lineFingerprint: string;
  status: 'completed' | 'failed';
  reason?: string;
  trendDirection?: 'up' | 'down' | 'flat' | 'new';
}

export interface BatchContributor {
  contribute(input: {
    reportDate: string;
    batchId: string;
    lineFingerprint: string;
    entry: BatchLineResult;
  }): Promise<{ isLast: boolean; batch?: { results: BatchLineResult[] } }>;
}

export interface PersistResultOutput {
  persisted: boolean;
  batchComplete: boolean;
  batch?: { lines: BatchLineResult[] };
}

/**
 * Writes the validated analysis into this line's memory slot — read back by
 * the worker as evidence the *next* time this exact line gets investigated,
 * never as a reason to skip investigating it (every `@mention` always
 * enqueues a fresh run; see `packages/core/src/cost-orchestration.ts`) — and
 * releases the lock and every concurrency reservation this owner token
 * holds, always, on the success path. The failure path (`handle-failure`'s
 * `HandleWorkflowError`) is the other place these same releases happen, so a
 * crash mid-investigation still frees the slot.
 *
 * Also contributes this line's outcome to the report round's fan-in batch
 * (see `DynamoBatchTracker`) — whichever of the N parallel per-line
 * executions turns out to be the last one home (`batchComplete: true`) is
 * responsible for triggering the one consolidated Slack message for the
 * whole report, via `$.completion.batch.lines` in the state machine.
 */
export async function persistResult(
  input: PersistResultInput,
  memory: MemoryWriter,
  locks: LockReleaser,
  concurrency: ConcurrencyReleaser,
  batches: BatchContributor,
): Promise<PersistResultOutput> {
  const now = new Date();
  await memory.putPriorAnalysis({
    lineFingerprint: input.lineFingerprint,
    value: input.analysis,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.memoryRetentionSeconds * 1_000).toISOString(),
  });
  for (const scopeKey of costConcurrencyScopeKeys(input.reportDate)) {
    await concurrency.release(scopeKey, input.ownerToken);
  }
  await locks.releaseLock(input.lineFingerprint, input.ownerToken);

  const contribution = await batches.contribute({
    reportDate: input.reportDate,
    batchId: input.batchId,
    lineFingerprint: input.lineFingerprint,
    entry: {
      lineLabel: input.lineLabel,
      lineFingerprint: input.lineFingerprint,
      status: 'completed',
      ...(input.trendDirection ? { trendDirection: input.trendDirection } : {}),
    },
  });
  const output: PersistResultOutput = { persisted: true, batchComplete: contribution.isLast };
  if (contribution.isLast && contribution.batch) {
    output.batch = { lines: contribution.batch.results };
  }
  return output;
}

import { costConcurrencyScopeKeys } from '../../../packages/core/src/index.js';
import type {
  BatchContributor,
  BatchLineResult,
  ConcurrencyReleaser,
  LockReleaser,
} from '../persist-result/handler.js';

export interface HandleFailureInput {
  reportDate: string;
  lineFingerprint: string;
  lineLabel: string;
  ownerToken: string;
  batchId: string;
  expectedCount: number;
  reason: string;
  errorMessage?: string;
  trendDirection?: 'up' | 'down' | 'flat' | 'new';
}

export interface HandleFailureOutput {
  released: boolean;
  batchComplete: boolean;
  batch?: { lines: BatchLineResult[] };
}

/**
 * The Catch-all path from every Step Functions state that could leave a
 * lock/concurrency reservation held (RunAgentWorkerOnECS, ValidateFinalAnalysis,
 * PersistAnalysis) — releases both unconditionally so a crash mid-investigation
 * never leaks a slot. `errorMessage` is logged only as a sanitized marker,
 * never verbatim (Step Functions error causes can carry raw exception text).
 *
 * Also contributes this line's failure to the report round's fan-in batch,
 * exactly like `persistResult` contributes a success — this is what stops
 * one failed line from silently hanging the whole report's consolidated
 * Slack message forever.
 */
export async function handleFailure(
  input: HandleFailureInput,
  locks: LockReleaser,
  concurrency: ConcurrencyReleaser,
  batches: BatchContributor,
): Promise<HandleFailureOutput> {
  for (const scopeKey of costConcurrencyScopeKeys(input.reportDate)) {
    await concurrency.release(scopeKey, input.ownerToken);
  }
  await locks.releaseLock(input.lineFingerprint, input.ownerToken);
  console.log(
    JSON.stringify({
      event: 'investigation_failed',
      reportDate: input.reportDate,
      lineFingerprint: input.lineFingerprint,
      reason: input.reason,
      errorMessage: input.errorMessage ? 'SANITIZED_RUNTIME_FAILURE' : undefined,
    }),
  );

  const contribution = await batches.contribute({
    reportDate: input.reportDate,
    batchId: input.batchId,
    lineFingerprint: input.lineFingerprint,
    entry: {
      lineLabel: input.lineLabel,
      lineFingerprint: input.lineFingerprint,
      status: 'failed',
      reason: input.reason,
      ...(input.trendDirection ? { trendDirection: input.trendDirection } : {}),
    },
  });
  const output: HandleFailureOutput = { released: true, batchComplete: contribution.isLast };
  if (contribution.isLast && contribution.batch) {
    output.batch = { lines: contribution.batch.results };
  }
  return output;
}

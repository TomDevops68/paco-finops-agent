import { costLineFingerprint } from './cost-fingerprint.js';
import { deriveCostOwnerToken } from './execution-identity.js';
import type { CostReportLine, NormalizedCostReport } from '../../schemas/src/index.js';

/**
 * Adapted from paco-troubleshoot-agent's `coordinateIngestion`
 * (packages/core/src/orchestration.ts), simplified for a domain that doesn't
 * need occurrence-counting or a two-stage fingerprint+deployment identity:
 * a cost report line has no "deployed version" and isn't received
 * repeatedly like a flood of duplicate error events — there's exactly one
 * investigation identity per line, `costLineFingerprint(report, line)`,
 * which doubles directly as the lock key (what the incident agent calls
 * `analysisKey`). Every notable `@mention` always enqueues a fresh
 * investigation — there is no cache/rate-limit short-circuit here by design;
 * the worker instead reads its own prior analysis for this line (if any) as
 * evidence, not as a reason to skip investigating (see
 * `apps/agent-worker/src/main.ts`).
 */
export interface InvestigationLock {
  tryAcquire(lineFingerprint: string, ownerToken: string, ttlMs: number, nowMs?: number): boolean;
  release(lineFingerprint: string, ownerToken: string): boolean;
}

export interface ConcurrencyLimiter {
  tryReserve(scopeKey: string, ownerToken: string, max: number, nowMs?: number): boolean;
  release(scopeKey: string, ownerToken: string): void;
}

export interface ConcurrencyBudget {
  limiter: ConcurrencyLimiter;
  maxGlobalInvestigations: number;
  maxPerReportInvestigations: number;
}

/** The concurrency scope keys for one line, without ceilings — used to release reservations by owner token without needing the original max values. */
export function costConcurrencyScopeKeys(reportDate: string): string[] {
  return ['CONC#GLOBAL', `CONC#REPORT#${reportDate}`];
}

function costConcurrencyScopes(
  reportDate: string,
  budget: ConcurrencyBudget,
): { scopeKey: string; max: number }[] {
  return [
    { scopeKey: 'CONC#GLOBAL', max: budget.maxGlobalInvestigations },
    { scopeKey: `CONC#REPORT#${reportDate}`, max: budget.maxPerReportInvestigations },
  ];
}

export interface CostInvestigationDecision {
  lineFingerprint: string;
  enqueueInvestigation: boolean;
  ownerToken?: string;
  concurrencyThrottled?: boolean;
  lockContended?: boolean;
}

export function coordinateCostInvestigation(input: {
  report: NormalizedCostReport;
  line: CostReportLine;
  sourceEventId: string;
  lockTtlMs: number;
  nowMs?: number;
  locks: InvestigationLock;
  concurrency: ConcurrencyBudget;
}): CostInvestigationDecision {
  const lineFingerprint = costLineFingerprint(input.report, input.line);
  const ownerToken = deriveCostOwnerToken(lineFingerprint, input.sourceEventId);
  const acquired = input.locks.tryAcquire(
    lineFingerprint,
    ownerToken,
    input.lockTtlMs,
    input.nowMs,
  );
  if (!acquired) {
    // Another execution already owns this line's investigation — not an
    // error, just nothing new to enqueue.
    return { lineFingerprint, enqueueInvestigation: false, lockContended: true };
  }

  const scopes = costConcurrencyScopes(input.report.reportDate, input.concurrency);
  const reserved: string[] = [];
  let concurrencyThrottled = false;
  for (const scope of scopes) {
    if (input.concurrency.limiter.tryReserve(scope.scopeKey, ownerToken, scope.max, input.nowMs)) {
      reserved.push(scope.scopeKey);
    } else {
      concurrencyThrottled = true;
      break;
    }
  }
  if (concurrencyThrottled) {
    for (const scopeKey of reserved) input.concurrency.limiter.release(scopeKey, ownerToken);
    input.locks.release(lineFingerprint, ownerToken);
    return { lineFingerprint, enqueueInvestigation: false, concurrencyThrottled: true };
  }

  return { lineFingerprint, ownerToken, enqueueInvestigation: true };
}

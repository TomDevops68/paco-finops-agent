import { describe, expect, it } from 'vitest';
import { coordinateCostInvestigation } from './cost-orchestration.js';
import type {
  ConcurrencyBudget,
  ConcurrencyLimiter,
  InvestigationLock,
} from './cost-orchestration.js';
import type { CostReportLine, NormalizedCostReport } from '../../schemas/src/index.js';

const line: CostReportLine = {
  label: 'Total AWS',
  kind: 'total',
  yesterdayUsd: 2782.88,
  trend: { direction: 'down', percent: 11.2 },
  currentUsd: 108045.38,
  forecastUsd: 123728.23,
};
const report: NormalizedCostReport = { reportDate: '2026-09-24', lines: [line] };

class FakeLock implements InvestigationLock {
  private owner: string | undefined;
  constructor(private acquirable = true) {}
  tryAcquire(_key: string, ownerToken: string): boolean {
    if (!this.acquirable) return false;
    this.owner = ownerToken;
    return true;
  }
  release(_key: string, ownerToken: string): boolean {
    if (this.owner !== ownerToken) return false;
    this.owner = undefined;
    return true;
  }
}

class FakeConcurrencyLimiter implements ConcurrencyLimiter {
  public released: string[] = [];
  constructor(private readonly deniedScopes: Set<string> = new Set()) {}
  tryReserve(scopeKey: string): boolean {
    return !this.deniedScopes.has(scopeKey);
  }
  release(scopeKey: string): void {
    this.released.push(scopeKey);
  }
}

function concurrency(overrides: Partial<ConcurrencyBudget> = {}): ConcurrencyBudget {
  return {
    limiter: new FakeConcurrencyLimiter(),
    maxGlobalInvestigations: 10,
    maxPerReportInvestigations: 3,
    ...overrides,
  };
}

describe('coordinateCostInvestigation', () => {
  it('reports lock contention when another execution already owns this line', () => {
    const decision = coordinateCostInvestigation({
      report,
      line,
      sourceEventId: 'Ev1',
      lockTtlMs: 60_000,
      locks: new FakeLock(false),
      concurrency: concurrency(),
    });
    expect(decision).toMatchObject({ enqueueInvestigation: false, lockContended: true });
  });

  it('throttles and rolls back reservations and the lock when a concurrency ceiling is hit', () => {
    const limiter = new FakeConcurrencyLimiter(new Set([`CONC#REPORT#${report.reportDate}`]));
    const decision = coordinateCostInvestigation({
      report,
      line,
      sourceEventId: 'Ev1',
      lockTtlMs: 60_000,
      locks: new FakeLock(),
      concurrency: concurrency({ limiter }),
    });
    expect(decision).toMatchObject({ enqueueInvestigation: false, concurrencyThrottled: true });
    // The GLOBAL scope was reserved before the REPORT scope failed, so it must be rolled back.
    expect(limiter.released).toEqual(['CONC#GLOBAL']);
  });

  it('enqueues with a derived owner token when every check passes', () => {
    const decision = coordinateCostInvestigation({
      report,
      line,
      sourceEventId: 'Ev1',
      lockTtlMs: 60_000,
      locks: new FakeLock(),
      concurrency: concurrency(),
    });
    expect(decision.enqueueInvestigation).toBe(true);
    expect(decision.ownerToken).toMatch(/^cost-[0-9a-f]{32}$/);
  });

  it('derives a different owner token for the same line on a different Slack event (redelivery-safe)', () => {
    const a = coordinateCostInvestigation({
      report,
      line,
      sourceEventId: 'Ev1',
      lockTtlMs: 60_000,
      locks: new FakeLock(),
      concurrency: concurrency(),
    });
    const b = coordinateCostInvestigation({
      report,
      line,
      sourceEventId: 'Ev2',
      lockTtlMs: 60_000,
      locks: new FakeLock(),
      concurrency: concurrency(),
    });
    expect(a.lineFingerprint).toBe(b.lineFingerprint);
    expect(a.ownerToken).not.toBe(b.ownerToken);
  });
});

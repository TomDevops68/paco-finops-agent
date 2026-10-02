import { describe, expect, it } from 'vitest';
import { costLineFingerprint, costReportFingerprint } from './cost-fingerprint.js';
import type { CostReportLine, NormalizedCostReport } from '../../schemas/src/index.js';

const totalLine: CostReportLine = {
  label: 'Total AWS',
  kind: 'total',
  yesterdayUsd: 2782.88,
  trend: { direction: 'down', percent: 11.2 },
  currentUsd: 108045.38,
  forecastUsd: 123728.23,
};

const prodLine: CostReportLine = {
  label: 'PACO - Production',
  kind: 'account',
  accountId: '510825518696',
  yesterdayUsd: 1844.47,
  trend: { direction: 'down', percent: 13.5 },
  currentUsd: 53562.5,
  forecastUsd: 64550.89,
};

const report: NormalizedCostReport = { reportDate: '2026-09-24', lines: [totalLine, prodLine] };

describe('costReportFingerprint', () => {
  it('is stable for the same report date regardless of line contents', () => {
    const a = costReportFingerprint(report);
    const b = costReportFingerprint({ ...report, lines: [totalLine] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for a different report date', () => {
    const a = costReportFingerprint(report);
    const b = costReportFingerprint({ ...report, reportDate: '2026-09-25' });
    expect(a).not.toBe(b);
  });
});

describe('costLineFingerprint', () => {
  it('differs per line within the same report', () => {
    const total = costLineFingerprint(report, totalLine);
    const prod = costLineFingerprint(report, prodLine);
    expect(total).not.toBe(prod);
  });

  it('is stable for the same report date, kind, and label', () => {
    const a = costLineFingerprint(report, prodLine);
    const b = costLineFingerprint(
      { ...report, reportDate: '2026-09-24' },
      { ...prodLine, yesterdayUsd: 999 },
    );
    expect(a).toBe(b);
  });
});

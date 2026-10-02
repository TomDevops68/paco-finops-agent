import { describe, expect, it } from 'vitest';
import { resolveContext, type CostReportReader } from './handler.js';
import type { PlaybooksConfig } from '../../../packages/config/src/index.js';
import { costLineFingerprint } from '../../../packages/core/src/index.js';
import type { NormalizedCostReport } from '../../../packages/schemas/src/index.js';

const novaLite = {
  label: 'Bedrock Nova Lite',
  kind: 'service' as const,
  yesterdayUsd: 0,
  trend: { direction: 'new' as const, percent: 0 },
  currentUsd: 0,
};
const prod = {
  label: 'PACO - Production',
  kind: 'account' as const,
  accountId: '510825518696',
  yesterdayUsd: 1844.47,
  trend: { direction: 'down' as const, percent: 13.5 },
  currentUsd: 53562.5,
  forecastUsd: 64550.89,
};
const report: NormalizedCostReport = { reportDate: '2026-09-24', lines: [novaLite, prod] };

const playbooksConfig: PlaybooksConfig = {
  schemaVersion: 1,
  selection: { new: 'NEW_SERVICE_OR_USAGE_TYPE', fallback: 'GENERIC' },
  playbooks: {
    NEW_SERVICE_OR_USAGE_TYPE: { enabledTools: ['mcp__cost__get_report'] },
    GENERIC: { enabledTools: ['mcp__cost__get_report', 'mcp__cost__describe_resources'] },
  },
};

function readerFor(record?: NormalizedCostReport): CostReportReader {
  return {
    getReport: (reportDate) =>
      Promise.resolve(record && record.reportDate === reportDate ? { report: record } : undefined),
  };
}

describe('resolveContext', () => {
  it('routes a new line to the narrower NEW_SERVICE_OR_USAGE_TYPE playbook', async () => {
    const result = await resolveContext(
      {
        reportDate: '2026-09-24',
        lineFingerprint: costLineFingerprint(report, novaLite),
        ownerToken: 'cost-abc',
      },
      readerFor(report),
      playbooksConfig,
    );
    expect(result).toEqual({
      outcome: 'RESOLVED',
      playbook: 'NEW_SERVICE_OR_USAGE_TYPE',
      line: novaLite,
      reportDate: '2026-09-24',
    });
  });

  it('routes an existing, changed line to the GENERIC playbook', async () => {
    const result = await resolveContext(
      {
        reportDate: '2026-09-24',
        lineFingerprint: costLineFingerprint(report, prod),
        ownerToken: 'cost-abc',
      },
      readerFor(report),
      playbooksConfig,
    );
    expect(result).toEqual({
      outcome: 'RESOLVED',
      playbook: 'GENERIC',
      line: prod,
      reportDate: '2026-09-24',
    });
  });

  it('reports REPORT_NOT_FOUND when the report date has no record', async () => {
    const result = await resolveContext(
      { reportDate: '2026-09-25', lineFingerprint: 'whatever', ownerToken: 'cost-abc' },
      readerFor(undefined),
      playbooksConfig,
    );
    expect(result).toEqual({ outcome: 'REPORT_NOT_FOUND', reportDate: '2026-09-25' });
  });

  it('reports LINE_NOT_FOUND when the fingerprint does not match any line in the report', async () => {
    const result = await resolveContext(
      { reportDate: '2026-09-24', lineFingerprint: 'stale-fingerprint', ownerToken: 'cost-abc' },
      readerFor(report),
      playbooksConfig,
    );
    expect(result).toEqual({ outcome: 'LINE_NOT_FOUND', reportDate: '2026-09-24' });
  });
});

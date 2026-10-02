import { describe, expect, it } from 'vitest';
import { validateAnalysis } from './handler.js';
import type { WorkerResult } from '../../../packages/agent-sdk-runtime/src/worker.js';

const baseInput = {
  reportDate: '2026-09-24',
  lineFingerprint: 'fp-1',
  ownerToken: 'cost-abc',
  resultKey: 'worker-results/cost-abc.json',
};

function workerResult(overrides: Partial<WorkerResult['analysis']['analysis']> = {}): WorkerResult {
  return {
    schemaVersion: '1.0',
    executionId: 'cost-abc',
    reportDate: '2026-09-24',
    lineFingerprint: 'fp-1',
    completedAt: '2026-09-24T13:10:00Z',
    sessionId: 'sess-1',
    terminalSubtype: 'success',
    analysis: {
      analysis: {
        classification: 'USAGE_GROWTH',
        status: 'LIKELY_DRIVER_IDENTIFIED',
        summary: 'Nova Lite usage grew.',
        driver: 'Token volume increase.',
        confidence: 0.9,
        evidence: [{ id: 'EV-abc', type: 'cost_explorer', statement: 'x' }],
        hypotheses: [],
        rejectedHypotheses: [],
        savingsRecommendations: [],
        limitations: [],
        serviceBreakdown: [],
        rootCauseEvidence: [],
        recommendedActions: [],
        ...overrides,
      },
      errors: [],
      downgraded: false,
    },
    evidenceCatalog: [
      {
        id: 'EV-abc',
        type: 'cost_explorer',
        summary: 'x',
        collectedAt: '2026-09-24T13:05:00Z',
        storageKey: 'k',
        metadata: {},
      },
    ],
    toolUses: ['mcp__cost__get_cost_and_usage'],
    usage: {
      startedAtMs: 0,
      turns: 3,
      toolCalls: 1,
      consecutiveToolErrors: 0,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.02,
    },
  };
}

describe('validateAnalysis', () => {
  it('reports MISSING_RESULT when the worker never committed a READY result', () => {
    const result = validateAnalysis(baseInput, undefined, {
      minimumConfidence: 0.75,
      minimumEvidenceTypes: 2,
    });
    expect(result).toEqual({
      outcome: 'MISSING_RESULT',
      reportDate: '2026-09-24',
      lineFingerprint: 'fp-1',
    });
  });

  it('independently downgrades a result whose self-reported validation understated the real evidence-type count', () => {
    const result = validateAnalysis(baseInput, workerResult(), {
      minimumConfidence: 0.75,
      minimumEvidenceTypes: 2,
    });
    expect(result.outcome).toBe('VALIDATED');
    if (result.outcome !== 'VALIDATED') return;
    // Only one evidence type (cost_explorer) was ever cited — the
    // independent re-check must downgrade regardless of what the worker's
    // own (in this case never actually re-run) validation said.
    expect(result.validation.analysis.status).toBe('HYPOTHESIS_ONLY');
    expect(result.validation.downgraded).toBe(true);
  });

  it('caps confidence when no resource-type evidence was collected', () => {
    const result = validateAnalysis(baseInput, workerResult({ confidence: 0.95 }), {
      minimumConfidence: 0.5,
      minimumEvidenceTypes: 1,
    });
    expect(result.outcome).toBe('VALIDATED');
    if (result.outcome !== 'VALIDATED') return;
    expect(result.validation.analysis.confidence).toBe(0.7);
  });
});

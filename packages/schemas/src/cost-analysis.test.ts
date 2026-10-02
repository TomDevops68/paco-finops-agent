import { describe, expect, it } from 'vitest';
import { FinalCostAnalysisSchema } from './cost-analysis.js';

function baseInput(): Record<string, unknown> {
  return {
    classification: 'GENERIC',
    status: 'INSUFFICIENT_EVIDENCE',
    summary: 'No driver found.',
    driver: null,
    confidence: 0.25,
    evidence: [],
    hypotheses: [],
    rejectedHypotheses: [],
    savingsRecommendations: [],
    limitations: [],
  };
}

describe('FinalCostAnalysisSchema', () => {
  // Regression: a model that only had MONTHLY (not DAILY) get_cost_and_usage
  // evidence has nothing valid to put in serviceBreakdown and previously
  // omitted the key entirely — every submit_final_analysis call was then
  // rejected at the MCP layer (`expected array, received undefined`), which
  // burned the session's turn/budget limit on unrecoverable retries.
  it('defaults serviceBreakdown to an empty array when omitted', () => {
    const result = FinalCostAnalysisSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
    expect(result.success && result.data.serviceBreakdown).toEqual([]);
  });

  it('still accepts an explicit serviceBreakdown array', () => {
    const result = FinalCostAnalysisSchema.safeParse({
      ...baseInput(),
      serviceBreakdown: [{ service: 'RDS', yesterdayUsd: 10, supportingEvidenceIds: ['EV-1'] }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.serviceBreakdown).toHaveLength(1);
  });

  it('defaults rootCauseEvidence and recommendedActions to empty arrays when omitted', () => {
    const result = FinalCostAnalysisSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
    expect(result.success && result.data.rootCauseEvidence).toEqual([]);
    expect(result.success && result.data.recommendedActions).toEqual([]);
  });

  it('accepts an explicit rootCauseEvidence array with required supportingEvidenceIds', () => {
    const result = FinalCostAnalysisSchema.safeParse({
      ...baseInput(),
      rootCauseEvidence: [
        {
          statement: 'API Gateway requests rose 116x over baseline.',
          supportingEvidenceIds: ['EV-1'],
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.rootCauseEvidence).toHaveLength(1);
  });

  it('rejects a rootCauseEvidence entry with no supportingEvidenceIds', () => {
    const result = FinalCostAnalysisSchema.safeParse({
      ...baseInput(),
      rootCauseEvidence: [{ statement: 'x', supportingEvidenceIds: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a recommendedActions entry without supportingEvidenceIds, defaulting to empty', () => {
    const result = FinalCostAnalysisSchema.safeParse({
      ...baseInput(),
      recommendedActions: [{ action: 'Confirm the traffic increase was intentional.' }],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.recommendedActions[0]?.supportingEvidenceIds).toEqual([]);
  });

  it('accepts sourceDiscrepancy when present and omits it when absent', () => {
    const withoutDiscrepancy = FinalCostAnalysisSchema.safeParse(baseInput());
    expect(withoutDiscrepancy.success).toBe(true);
    expect(withoutDiscrepancy.success && withoutDiscrepancy.data.sourceDiscrepancy).toBeUndefined();

    const withDiscrepancy = FinalCostAnalysisSchema.safeParse({
      ...baseInput(),
      sourceDiscrepancy: {
        dashboardUsd: 1844.47,
        costExplorerUsd: 1990.12,
        note: 'AWS backfilled late-arriving usage after the dashboard snapshot was taken.',
        supportingEvidenceIds: ['EV-1'],
      },
    });
    expect(withDiscrepancy.success).toBe(true);
    expect(withDiscrepancy.success && withDiscrepancy.data.sourceDiscrepancy?.costExplorerUsd).toBe(
      1990.12,
    );
  });

  it('rejects sourceDiscrepancy with no supportingEvidenceIds', () => {
    const result = FinalCostAnalysisSchema.safeParse({
      ...baseInput(),
      sourceDiscrepancy: {
        dashboardUsd: 1844.47,
        costExplorerUsd: 1990.12,
        note: 'x',
        supportingEvidenceIds: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

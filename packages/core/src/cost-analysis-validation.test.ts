import { describe, expect, it } from 'vitest';
import { validateCostAnalysisEvidence } from './cost-analysis-validation.js';
import type { CostEvidenceRecord, FinalCostAnalysis } from '../../schemas/src/index.js';

const catalog: CostEvidenceRecord[] = [
  {
    id: 'EV-abc123',
    type: 'cost_explorer',
    summary: 'Bedrock usage-type breakdown for 2026-09-24',
    collectedAt: '2026-09-24T13:05:00Z',
    storageKey: 'evidence/2026-09-24/EV-abc123.json',
    metadata: {},
  },
  {
    id: 'EV-def456',
    type: 'resource',
    summary: 'ECS service desired count history',
    collectedAt: '2026-09-24T13:06:00Z',
    storageKey: 'evidence/2026-09-24/EV-def456.json',
    metadata: {},
  },
];

function analysis(overrides: Partial<FinalCostAnalysis> = {}): FinalCostAnalysis {
  return {
    classification: 'USAGE_GROWTH',
    status: 'LIKELY_DRIVER_IDENTIFIED',
    summary: 'Bedrock Nova Lite usage grew.',
    driver: 'Increased token volume on the Nova Lite usage type.',
    confidence: 0.85,
    evidence: [
      { id: 'EV-abc123', type: 'cost_explorer', statement: 'Nova Lite usage type cost rose.' },
      { id: 'EV-def456', type: 'resource', statement: 'No ECS scaling change in the window.' },
    ],
    hypotheses: [],
    rejectedHypotheses: [],
    savingsRecommendations: [],
    limitations: [],
    serviceBreakdown: [],
    rootCauseEvidence: [],
    recommendedActions: [],
    ...overrides,
  };
}

const strictOptions = {
  minimumConfidence: 0.75,
  minimumEvidenceTypes: 2,
  resourceEvidenceVerified: true,
};

describe('validateCostAnalysisEvidence', () => {
  it('keeps a well-evidenced LIKELY_DRIVER_IDENTIFIED result unchanged', () => {
    const result = validateCostAnalysisEvidence(analysis(), catalog, strictOptions);
    expect(result.analysis.status).toBe('LIKELY_DRIVER_IDENTIFIED');
    expect(result.errors).toEqual([]);
    expect(result.downgraded).toBe(false);
  });

  it('downgrades to HYPOTHESIS_ONLY when confidence is below the minimum', () => {
    const result = validateCostAnalysisEvidence(
      analysis({ confidence: 0.5 }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.status).toBe('HYPOTHESIS_ONLY');
    expect(result.downgraded).toBe(true);
  });

  it('downgrades when fewer than the minimum distinct evidence types are cited', () => {
    const result = validateCostAnalysisEvidence(
      analysis({ evidence: [{ id: 'EV-abc123', type: 'cost_explorer', statement: 'x' }] }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.status).toBe('HYPOTHESIS_ONLY');
  });

  it('flags and downgrades on an unknown or mistyped evidence ID', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        evidence: [...analysis().evidence, { id: 'EV-fake', type: 'anomaly', statement: 'x' }],
      }),
      catalog,
      strictOptions,
    );
    expect(result.errors).toContain('Unknown evidence ID: EV-fake');
    expect(result.analysis.status).toBe('HYPOTHESIS_ONLY');
  });

  it('caps confidence and adds a limitation when resource evidence is unverified', () => {
    const result = validateCostAnalysisEvidence(analysis({ confidence: 0.95 }), catalog, {
      ...strictOptions,
      resourceEvidenceVerified: false,
    });
    expect(result.analysis.confidence).toBe(0.7);
    expect(result.analysis.limitations).toContain('Resource-level evidence could not be verified.');
    expect(result.downgraded).toBe(true);
  });

  it('never downgrades a status that was not claiming LIKELY_DRIVER_IDENTIFIED', () => {
    const result = validateCostAnalysisEvidence(
      analysis({ status: 'INSUFFICIENT_EVIDENCE', confidence: 0.1, evidence: [] }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('strips estimatedMonthlySavingsUsd from a recommendation with no valid supporting evidence', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        savingsRecommendations: [
          {
            action: 'Migrate paco-talk-prod-ecs-cluster to Fargate Spot',
            lever: 'fargate-spot-migrator',
            estimatedMonthlySavingsUsd: 120,
            supportingEvidenceIds: ['EV-not-real'],
            requiresHumanApproval: true,
          },
        ],
      }),
      catalog,
      strictOptions,
    );
    const [recommendation] = result.analysis.savingsRecommendations;
    expect(recommendation?.estimatedMonthlySavingsUsd).toBeUndefined();
    expect(
      result.errors.some((error) =>
        error.includes('Stripped unsupported estimatedMonthlySavingsUsd'),
      ),
    ).toBe(true);
  });

  it('keeps estimatedMonthlySavingsUsd when it cites a real evidence ID', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        savingsRecommendations: [
          {
            action: 'Migrate paco-talk-prod-ecs-cluster to Fargate Spot',
            lever: 'fargate-spot-migrator',
            estimatedMonthlySavingsUsd: 120,
            supportingEvidenceIds: ['EV-abc123'],
            requiresHumanApproval: true,
          },
        ],
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.savingsRecommendations[0]?.estimatedMonthlySavingsUsd).toBe(120);
  });

  it('drops a serviceBreakdown entry with no valid supporting evidence', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        serviceBreakdown: [
          { service: 'RDS', yesterdayUsd: 612.3, supportingEvidenceIds: ['EV-not-real'] },
        ],
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.serviceBreakdown).toEqual([]);
    expect(
      result.errors.some((error) => error.includes('Dropped unsupported serviceBreakdown entry')),
    ).toBe(true);
  });

  it('keeps a serviceBreakdown entry that cites a real evidence ID', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        serviceBreakdown: [
          { service: 'RDS', yesterdayUsd: 612.3, supportingEvidenceIds: ['EV-abc123'] },
        ],
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.serviceBreakdown).toHaveLength(1);
  });

  it('drops a rootCauseEvidence entry with no valid supporting evidence', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        rootCauseEvidence: [
          { statement: 'API Gateway requests rose 116x.', supportingEvidenceIds: ['EV-not-real'] },
        ],
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.rootCauseEvidence).toEqual([]);
    expect(
      result.errors.some((error) => error.includes('Dropped unsupported rootCauseEvidence entry')),
    ).toBe(true);
  });

  it('keeps a rootCauseEvidence entry that cites a real evidence ID', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        rootCauseEvidence: [
          { statement: 'API Gateway requests rose 116x.', supportingEvidenceIds: ['EV-abc123'] },
        ],
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.rootCauseEvidence).toHaveLength(1);
  });

  it('drops sourceDiscrepancy with no valid supporting evidence', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        sourceDiscrepancy: {
          dashboardUsd: 100,
          costExplorerUsd: 130,
          note: 'AWS backfilled late-arriving usage.',
          supportingEvidenceIds: ['EV-not-real'],
        },
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.sourceDiscrepancy).toBeUndefined();
    expect(
      result.errors.some((error) => error.includes('Dropped unsupported sourceDiscrepancy')),
    ).toBe(true);
  });

  it('keeps sourceDiscrepancy that cites a real evidence ID', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        sourceDiscrepancy: {
          dashboardUsd: 100,
          costExplorerUsd: 130,
          note: 'AWS backfilled late-arriving usage.',
          supportingEvidenceIds: ['EV-abc123'],
        },
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.sourceDiscrepancy?.costExplorerUsd).toBe(130);
  });

  it('passes recommendedActions through unchanged regardless of evidence', () => {
    const result = validateCostAnalysisEvidence(
      analysis({
        recommendedActions: [
          { action: 'Enable API Gateway access logging.', supportingEvidenceIds: [] },
        ],
      }),
      catalog,
      strictOptions,
    );
    expect(result.analysis.recommendedActions).toHaveLength(1);
  });
});

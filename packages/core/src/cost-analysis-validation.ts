import type { CostEvidenceRecord, FinalCostAnalysis } from '../../schemas/src/index.js';

export interface CostAnalysisValidationResult {
  analysis: FinalCostAnalysis;
  errors: string[];
  downgraded: boolean;
}

/**
 * Adapted from paco-troubleshoot-agent's `validateAnalysisEvidence`
 * (packages/core/src/analysis-validation.ts) — same "the model cannot
 * upgrade its own claim beyond what the harness independently confirms"
 * shape, applied to cost evidence types instead of incident ones. Two
 * additions specific to this domain:
 *
 * 1. `resourceEvidenceVerified` replaces `sourceVersionVerified`: caps
 *    confidence when the conclusion rests only on Cost Explorer aggregates
 *    with no resource-level (`resource`/`deployment`-typed) correlation —
 *    the cost-domain equivalent of "the deployed source couldn't be
 *    verified."
 * 2. `estimatedMonthlySavingsUsd` is stripped from any savings
 *    recommendation that doesn't cite at least one real evidence ID —
 *    enforces the schema comment's promise that this number is never the
 *    model's own arithmetic, only ever copied from a tool result.
 * 3. `serviceBreakdown` entries are dropped entirely (not just their
 *    numbers) when none of their `supportingEvidenceIds` resolve in the
 *    catalog — unlike a savings estimate, a breakdown entry with no real
 *    backing has nothing worth keeping.
 */
export function validateCostAnalysisEvidence(
  input: FinalCostAnalysis,
  catalog: readonly CostEvidenceRecord[],
  options: {
    minimumConfidence: number;
    minimumEvidenceTypes: number;
    resourceEvidenceVerified: boolean;
  },
): CostAnalysisValidationResult {
  const errors: string[] = [];
  const byId = new Map(catalog.map((evidence) => [evidence.id, evidence]));

  for (const claim of input.evidence) {
    const record = byId.get(claim.id);
    if (!record) errors.push(`Unknown evidence ID: ${claim.id}`);
    else if (record.type !== claim.type) errors.push(`Evidence type mismatch: ${claim.id}`);
  }

  const evidenceTypes = new Set(input.evidence.map((evidence) => evidence.type));
  const cannotBeLikely =
    input.confidence < options.minimumConfidence ||
    evidenceTypes.size < options.minimumEvidenceTypes ||
    errors.length > 0;
  const unverifiedConfidence = options.resourceEvidenceVerified
    ? input.confidence
    : Math.min(input.confidence, 0.7);
  const shouldDowngrade = input.status === 'LIKELY_DRIVER_IDENTIFIED' && cannotBeLikely;

  const savingsRecommendations = input.savingsRecommendations.map((recommendation) => {
    const hasValidEvidence = recommendation.supportingEvidenceIds.some((id) => byId.has(id));
    if (recommendation.estimatedMonthlySavingsUsd !== undefined && !hasValidEvidence) {
      errors.push(
        `Stripped unsupported estimatedMonthlySavingsUsd from recommendation: ${recommendation.action.slice(0, 80)}`,
      );
      return {
        action: recommendation.action,
        lever: recommendation.lever,
        supportingEvidenceIds: recommendation.supportingEvidenceIds,
        requiresHumanApproval: recommendation.requiresHumanApproval,
      };
    }
    return recommendation;
  });

  const serviceBreakdown = input.serviceBreakdown.filter((entry) => {
    const hasValidEvidence = entry.supportingEvidenceIds.some((id) => byId.has(id));
    if (!hasValidEvidence) {
      errors.push(`Dropped unsupported serviceBreakdown entry: ${entry.service}`);
    }
    return hasValidEvidence;
  });

  const rootCauseEvidence = input.rootCauseEvidence.filter((entry) => {
    const hasValidEvidence = entry.supportingEvidenceIds.some((id) => byId.has(id));
    if (!hasValidEvidence) {
      errors.push(`Dropped unsupported rootCauseEvidence entry: ${entry.statement.slice(0, 80)}`);
    }
    return hasValidEvidence;
  });

  const sourceDiscrepancyHasValidEvidence =
    input.sourceDiscrepancy?.supportingEvidenceIds.some((id) => byId.has(id)) ?? false;
  if (input.sourceDiscrepancy && !sourceDiscrepancyHasValidEvidence) {
    errors.push('Dropped unsupported sourceDiscrepancy');
  }
  const sourceDiscrepancy =
    input.sourceDiscrepancy && sourceDiscrepancyHasValidEvidence
      ? input.sourceDiscrepancy
      : undefined;

  const analysis: FinalCostAnalysis = {
    ...input,
    status: shouldDowngrade ? 'HYPOTHESIS_ONLY' : input.status,
    confidence: unverifiedConfidence,
    savingsRecommendations,
    serviceBreakdown,
    rootCauseEvidence,
    limitations: options.resourceEvidenceVerified
      ? input.limitations
      : [...new Set([...input.limitations, 'Resource-level evidence could not be verified.'])],
  };
  if (sourceDiscrepancy) analysis.sourceDiscrepancy = sourceDiscrepancy;
  else delete analysis.sourceDiscrepancy;

  return {
    analysis,
    errors,
    downgraded: shouldDowngrade || unverifiedConfidence !== input.confidence,
  };
}

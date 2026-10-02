import { validateCostAnalysisEvidence } from '../../../packages/core/src/index.js';
import type { WorkerResult } from '../../../packages/agent-sdk-runtime/src/worker.js';

export interface ValidateAnalysisInput {
  reportDate: string;
  lineFingerprint: string;
  ownerToken: string;
  resultKey: string;
}

export type ValidateAnalysisResult =
  | { outcome: 'MISSING_RESULT'; reportDate: string; lineFingerprint: string }
  | { outcome: 'VALIDATED'; result: WorkerResult; validation: WorkerResult['analysis'] };

/**
 * Independently re-validates the worker's self-reported analysis against
 * its own submitted evidence catalog (ADR-0004: the supervisor never trusts
 * a worker's validation, only its raw evidence) — same
 * `validateCostAnalysisEvidence` call the worker itself already ran, run
 * again here so a compromised or buggy worker process can't just report
 * `downgraded: false` and have that taken at face value.
 */
export function validateAnalysis(
  input: ValidateAnalysisInput,
  workerResult: WorkerResult | undefined,
  options: { minimumConfidence: number; minimumEvidenceTypes: number },
): ValidateAnalysisResult {
  if (!workerResult)
    return {
      outcome: 'MISSING_RESULT',
      reportDate: input.reportDate,
      lineFingerprint: input.lineFingerprint,
    };

  const resourceEvidenceVerified = workerResult.evidenceCatalog.some(
    (evidence) => evidence.type === 'resource',
  );
  const validation = validateCostAnalysisEvidence(
    workerResult.analysis.analysis,
    workerResult.evidenceCatalog,
    {
      minimumConfidence: options.minimumConfidence,
      minimumEvidenceTypes: options.minimumEvidenceTypes,
      resourceEvidenceVerified,
    },
  );
  return { outcome: 'VALIDATED', result: workerResult, validation };
}

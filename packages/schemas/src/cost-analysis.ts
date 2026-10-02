import { z } from 'zod';

/**
 * The narrative category the model concludes with. Deliberately not what
 * Phase 2's deterministic pre-routing selects (see `packages/core/src/
 * cost-playbook.ts`'s `selectRoutingPlaybook`) — a report line's trend alone
 * can only ever tell you `NEW_SERVICE_OR_USAGE_TYPE` or "something changed,
 * investigate" (`GENERIC`); which of the remaining six categories actually
 * applies requires the evidence tools below, so only the model — after
 * gathering that evidence — is in a position to pick one.
 */
export const CostClassificationSchema = z.enum([
  'NEW_SERVICE_OR_USAGE_TYPE',
  'USAGE_GROWTH',
  'SCALING_OR_DEPLOYMENT_CHANGE',
  'RI_SP_COVERAGE_DROP',
  'ONE_OFF_SPIKE',
  'FORECAST_OVERRUN',
  'IDLE_OR_UNDERUTILIZED_RESOURCE',
  'GENERIC',
]);

export const CostAnalysisStatusSchema = z.enum([
  'LIKELY_DRIVER_IDENTIFIED',
  'HYPOTHESIS_ONLY',
  'INSUFFICIENT_EVIDENCE',
  'BUDGET_EXHAUSTED',
]);

export const CostEvidenceTypeSchema = z.enum([
  'cost_explorer',
  'anomaly',
  'ri_sp',
  'resource',
  'deployment',
  'historical',
  'cloudwatch_metric',
  'cloudtrail_event',
]);

const CostEvidenceClaimSchema = z.object({
  id: z.string().min(1),
  type: CostEvidenceTypeSchema,
  statement: z.string().min(1).max(1_500),
});

/**
 * `lever` names an existing, already-deployed mutation mechanism instead of
 * describing a new one — see docs/adr/0001-dedicated-bot-and-readonly-
 * boundary.md. `estimatedMonthlySavingsUsd` must only ever be copied from a
 * real Cost Explorer/rightsizing tool result; there's no schema-level way to
 * enforce that, so `validateCostAnalysisEvidence` (packages/core/src/
 * cost-analysis-validation.ts) strips it back out whenever it isn't backed
 * by a cited `cost_explorer`-typed evidence claim.
 */
const CostSavingsRecommendationSchema = z.object({
  action: z.string().min(1).max(2_000),
  lever: z.enum(['fargate-spot-migrator', 'scheduler-worker', 'rds-aurora-scheduler', 'manual']),
  estimatedMonthlySavingsUsd: z.number().nonnegative().optional(),
  /** Evidence IDs that back `estimatedMonthlySavingsUsd` — required to keep the number, see `validateCostAnalysisEvidence`. */
  supportingEvidenceIds: z.array(z.string()),
  requiresHumanApproval: z.literal(true),
});

/**
 * Per-AWS-service cost for the same three days under investigation. Gathered
 * as evidence but no longer rendered in the Slack notification (dropped
 * 2026-10-01 to keep the consolidated message short — see
 * `apps/functions/notify-slack/handler.ts`). Numbers must be copied from a
 * real `get_cost_and_usage` call grouped by SERVICE, never computed by the
 * model — `supportingEvidenceIds` is required so `validateCostAnalysisEvidence`
 * can drop any entry that isn't backed by a real evidence ID.
 */
const CostServiceBreakdownEntrySchema = z.object({
  service: z.string().min(1).max(200),
  yesterdayUsd: z.number(),
  dayBeforeUsd: z.number().optional(),
  twoDaysAgoUsd: z.number().optional(),
  supportingEvidenceIds: z.array(z.string()).min(1),
});

/**
 * Flags AWS's own late-arriving-usage backfill: the dashboard's own snapshot
 * figure (already known, no tool call needed) vs. a fresh `get_cost_and_usage`
 * figure for the same day/account. Only populated when the two differ
 * meaningfully — `validateCostAnalysisEvidence` drops the whole object if
 * `supportingEvidenceIds` doesn't resolve, since there's no sensible partial
 * version of a two-number comparison.
 */
const CostSourceDiscrepancySchema = z.object({
  dashboardUsd: z.number(),
  costExplorerUsd: z.number(),
  note: z.string().min(1).max(300),
  supportingEvidenceIds: z.array(z.string()).min(1),
});

/**
 * Specific, quantified signals behind the conclusion (a traffic multiplier, a
 * CloudTrail-attributed config change, a concurrency-scaling charge) —
 * distinct from the narrative `driver`/`summary`. Required evidence per
 * bullet, same whole-entry-drop pattern as `serviceBreakdown`.
 */
const CostRootCauseEvidenceEntrySchema = z.object({
  statement: z.string().min(1).max(500),
  supportingEvidenceIds: z.array(z.string()).min(1),
});

/**
 * Ops-facing suggestions (e.g. "enable API Gateway access logging") — advisory
 * and read-only, never a claim of executed action, so unlike
 * `savingsRecommendations`/`serviceBreakdown` these aren't evidence-gated.
 */
const CostRecommendedActionSchema = z.object({
  action: z.string().min(1).max(300),
  supportingEvidenceIds: z.array(z.string()).default([]),
});

export const FinalCostAnalysisSchema = z.object({
  classification: CostClassificationSchema,
  status: CostAnalysisStatusSchema,
  summary: z.string().min(1).max(4_000),
  driver: z.string().min(1).max(4_000).nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(CostEvidenceClaimSchema).max(50),
  hypotheses: z
    .array(
      z.object({
        statement: z.string().min(1).max(2_000),
        confidence: z.number().min(0).max(1),
        supportingEvidenceIds: z.array(z.string()),
        contradictingEvidenceIds: z.array(z.string()),
      }),
    )
    .max(20),
  rejectedHypotheses: z
    .array(
      z.object({
        statement: z.string().min(1).max(2_000),
        reason: z.string().min(1).max(2_000),
        evidenceIds: z.array(z.string()),
      }),
    )
    .max(20),
  savingsRecommendations: z.array(CostSavingsRecommendationSchema).max(20),
  limitations: z.array(z.string().min(1).max(2_000)).max(20),
  // `.default([])`: when the model never got DAILY-granularity evidence (e.g.
  // it queried MONTHLY, or ran out of turns before that call), it has
  // nothing valid to put here and previously just omitted the key — MCP-level
  // validation then rejected every `submit_final_analysis` call outright,
  // with no way to recover before the session's turn/budget limit hit.
  serviceBreakdown: z.array(CostServiceBreakdownEntrySchema).max(30).default([]),
  sourceDiscrepancy: CostSourceDiscrepancySchema.optional(),
  rootCauseEvidence: z.array(CostRootCauseEvidenceEntrySchema).max(15).default([]),
  recommendedActions: z.array(CostRecommendedActionSchema).max(10).default([]),
});

export type CostClassification = z.infer<typeof CostClassificationSchema>;
export type CostEvidenceType = z.infer<typeof CostEvidenceTypeSchema>;
export type FinalCostAnalysis = z.infer<typeof FinalCostAnalysisSchema>;
export type CostServiceBreakdownEntry = z.infer<typeof CostServiceBreakdownEntrySchema>;

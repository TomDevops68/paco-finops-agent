import { z } from 'zod';

/**
 * Mirrors `paco-daily-cost-report`'s `get_trend_info()`: an icon-derived
 * direction plus the percent magnitude it was posted with. `NEW` lines carry
 * `percent: 0` because the source Lambda hardcodes `"0%"` for them — that's
 * a real property of the upstream format, not a parsing gap.
 */
export const CostReportTrendSchema = z.object({
  direction: z.enum(['up', 'down', 'flat', 'new']),
  percent: z.number().nonnegative(),
});

/**
 * `total` — the "Total AWS" org-wide line (always present, no bullet).
 * `service` — a bulleted line with no Forecast field (e.g. "Bedrock Nova
 * Lite" in the source Lambda) — a cost slice, not an account.
 * `account` — a bulleted line with a Forecast field, one per linked AWS
 * account in the source Lambda's `ACCOUNT_MAP`.
 */
export const CostReportLineSchema = z.object({
  label: z.string().min(1),
  kind: z.enum(['total', 'service', 'account']),
  accountId: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
  yesterdayUsd: z.number(),
  trend: CostReportTrendSchema,
  currentUsd: z.number(),
  forecastUsd: z.number().optional(),
});

export const NormalizedCostReportSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(CostReportLineSchema).min(1),
});

export type CostReportTrend = z.infer<typeof CostReportTrendSchema>;
export type CostReportLine = z.infer<typeof CostReportLineSchema>;
export type NormalizedCostReport = z.infer<typeof NormalizedCostReportSchema>;

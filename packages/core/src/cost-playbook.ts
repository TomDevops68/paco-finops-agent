import type { CostReportLine } from '../../schemas/src/index.js';

/**
 * What can be determined from the report line alone, before any Cost
 * Explorer/Compute Optimizer evidence exists. This is deliberately coarser
 * than the full diagnostic-playbook set in `COST_AGENT_BUILD_SPEC.md`
 * (`NEW_SERVICE_OR_USAGE_TYPE`, `USAGE_GROWTH`, `RI_SP_COVERAGE_DROP`, …) —
 * those categories require evidence-tool signals that don't exist yet
 * (Phase 2/3). Building that seven-way classifier now, with nothing but a
 * parsed line to feed it, would be guessing dressed up as logic.
 */
export type CostSignificance = 'new' | 'increase' | 'decrease' | 'unchanged';

export interface CostSignificanceThresholds {
  /** Percent trend magnitude at/above which a line is worth investigating. */
  significantChangePercent: number;
  /**
   * Report line labels (exact match) to never treat as notable, regardless
   * of trend — an operational escape hatch for a line that's structurally
   * always "new" (e.g. a $0.00/day service with no real usage) and would
   * otherwise burn an investigation slot every single report.
   */
  excludedLabels?: readonly string[];
}

export function classifySignificance(line: CostReportLine): CostSignificance {
  if (line.trend.direction === 'new') return 'new';
  if (line.trend.direction === 'up') return 'increase';
  if (line.trend.direction === 'down') return 'decrease';
  return 'unchanged';
}

/**
 * A line is notable when it's brand new, or its trend magnitude clears the
 * configured threshold — mirrors the "deterministic routing before any LLM
 * call" principle from the troubleshoot agent's playbook selection, applied
 * to the one signal available at parse time.
 */
export function isNotable(line: CostReportLine, thresholds: CostSignificanceThresholds): boolean {
  if (thresholds.excludedLabels?.includes(line.label)) return false;
  if (line.trend.direction === 'new') return true;
  return line.trend.percent >= thresholds.significantChangePercent;
}

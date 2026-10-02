import { z } from 'zod';

export const InvestigationLimitsSchema = z.object({
  maxDurationSeconds: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().positive(),
  maxToolCalls: z.number().int().positive(),
  maxConsecutiveToolErrors: z.number().int().positive(),
  maxRepeatedEquivalentToolCalls: z.number().int().positive(),
  maxCumulativeInputTokens: z.number().int().positive(),
  maxCumulativeOutputTokens: z.number().int().positive(),
});

export type InvestigationLimits = z.infer<typeof InvestigationLimitsSchema>;

export interface BudgetUsage {
  startedAtMs: number;
  turns: number;
  toolCalls: number;
  consecutiveToolErrors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type BudgetStopReason =
  | 'duration'
  | 'turns'
  | 'cost'
  | 'tool_calls'
  | 'tool_errors'
  | 'input_tokens'
  | 'output_tokens';

/** Ported from paco-troubleshoot-agent's packages/core/src/budget.ts — fully generic, no incident-specific coupling. */
export function budgetStopReason(
  limits: InvestigationLimits,
  usage: BudgetUsage,
  nowMs = Date.now(),
): BudgetStopReason | null {
  if (nowMs - usage.startedAtMs >= limits.maxDurationSeconds * 1_000) return 'duration';
  if (usage.turns >= limits.maxTurns) return 'turns';
  if (usage.costUsd >= limits.maxBudgetUsd) return 'cost';
  if (usage.toolCalls >= limits.maxToolCalls) return 'tool_calls';
  if (usage.consecutiveToolErrors >= limits.maxConsecutiveToolErrors) return 'tool_errors';
  if (usage.inputTokens >= limits.maxCumulativeInputTokens) return 'input_tokens';
  if (usage.outputTokens >= limits.maxCumulativeOutputTokens) return 'output_tokens';
  return null;
}

import { describe, expect, it } from 'vitest';
import { budgetStopReason, type BudgetUsage, type InvestigationLimits } from './budget.js';

const limits: InvestigationLimits = {
  maxDurationSeconds: 600,
  maxTurns: 12,
  maxBudgetUsd: 0.75,
  maxToolCalls: 20,
  maxConsecutiveToolErrors: 3,
  maxRepeatedEquivalentToolCalls: 2,
  maxCumulativeInputTokens: 80_000,
  maxCumulativeOutputTokens: 10_000,
};

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    startedAtMs: 0,
    turns: 0,
    toolCalls: 0,
    consecutiveToolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

describe('budgetStopReason', () => {
  it('returns null when every dimension is within budget', () => {
    expect(budgetStopReason(limits, usage(), 1_000)).toBeNull();
  });

  it('flags duration first when wall-clock time is exceeded', () => {
    expect(budgetStopReason(limits, usage({ startedAtMs: 0 }), 600_001)).toBe('duration');
  });

  it('flags each remaining dimension independently', () => {
    expect(budgetStopReason(limits, usage({ turns: 12 }), 1_000)).toBe('turns');
    expect(budgetStopReason(limits, usage({ costUsd: 0.75 }), 1_000)).toBe('cost');
    expect(budgetStopReason(limits, usage({ toolCalls: 20 }), 1_000)).toBe('tool_calls');
    expect(budgetStopReason(limits, usage({ consecutiveToolErrors: 3 }), 1_000)).toBe(
      'tool_errors',
    );
    expect(budgetStopReason(limits, usage({ inputTokens: 80_000 }), 1_000)).toBe('input_tokens');
    expect(budgetStopReason(limits, usage({ outputTokens: 10_000 }), 1_000)).toBe('output_tokens');
  });
});

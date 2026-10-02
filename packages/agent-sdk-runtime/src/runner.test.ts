import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { runAgentSession, type AgentMessageStreamFactory } from './runner.js';
import type { BudgetUsage } from '../../core/src/index.js';

function usage(): BudgetUsage {
  return {
    startedAtMs: Date.now(),
    turns: 0,
    toolCalls: 0,
    consecutiveToolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

const baseInput = {
  prompt: 'investigate',
  options: {} as Options,
  classification: 'GENERIC' as const,
  evidenceCatalog: [],
  evidenceValidation: {
    minimumConfidence: 0.5,
    minimumEvidenceTypes: 1,
    resourceEvidenceVerified: true,
  },
  finalAnswerToolName: 'submit_final_analysis',
};

// Regression for a live production incident: a session that legitimately
// terminated with `error_max_budget_usd` had that terminalSubtype silently
// overwritten to the generic `error_during_execution` because the read loop
// kept pulling from the SDK stream after its terminal `result` message,
// and that extra pull threw.
function streamThatThrowsAfterResult(subtype: string): AgentMessageStreamFactory {
  return () => ({
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        next: () => {
          step += 1;
          if (step === 1) {
            return Promise.resolve({
              value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              done: false,
            });
          }
          if (step === 2) {
            return Promise.resolve({ value: { type: 'result', subtype }, done: false });
          }
          return Promise.reject(new Error('stream already closed'));
        },
      };
    },
  });
}

describe('runAgentSession', () => {
  it('preserves the real terminal subtype instead of clobbering it after the result message', async () => {
    const result = await runAgentSession(
      { ...baseInput, usage: usage() },
      streamThatThrowsAfterResult('error_max_budget_usd'),
    );
    expect(result.terminalSubtype).toBe('error_max_budget_usd');
    expect(result.analysis.analysis.status).toBe('BUDGET_EXHAUSTED');
    expect(result.analysis.analysis.summary).toBe(
      'The investigation stopped at a configured budget limit.',
    );
  });

  it('still reports error_during_execution when the stream throws before any result message', async () => {
    const throwsImmediately: AgentMessageStreamFactory = () => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('boom')) };
      },
    });
    const result = await runAgentSession({ ...baseInput, usage: usage() }, throwsImmediately);
    expect(result.terminalSubtype).toBe('error_during_execution');
    expect(result.analysis.analysis.status).toBe('INSUFFICIENT_EVIDENCE');
  });
});

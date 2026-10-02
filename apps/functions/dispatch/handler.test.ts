import { describe, expect, it, vi } from 'vitest';
import { dispatch, type ExecutionStarter } from './handler.js';

describe('dispatch', () => {
  it('starts an execution named after the owner token, with the message as JSON input', async () => {
    const startExecution = vi.fn().mockResolvedValue(undefined);
    const executions: ExecutionStarter = { startExecution };
    const message = {
      reportDate: '2026-09-24',
      lineFingerprint: 'fp-1',
      lineLabel: 'Total AWS',
      ownerToken: 'cost-abc',
      slackChannel: 'C1',
      slackThreadTs: '123.456',
      batchId: 'evt-1',
      expectedCount: 3,
      trendDirection: 'up' as const,
    };
    await dispatch(message, executions);
    expect(startExecution).toHaveBeenCalledWith({
      name: 'cost-abc',
      input: JSON.stringify(message),
    });
  });
});

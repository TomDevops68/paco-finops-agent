import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoBatchTracker, type DynamoCommandClient } from './dynamodb.js';

/**
 * A minimal in-memory stand-in for DynamoDB's conditional-write semantics,
 * scoped to exactly the two commands DynamoBatchTracker issues (Put with
 * `attribute_not_exists(controlKey)`, Update with a fingerprint-Set dedupe
 * condition + `ADD`/`list_append`). Faithful enough to exercise the "last
 * one home" race-safety logic without a real DynamoDB.
 */
function fakeDynamoTable(): { client: DynamoCommandClient } {
  const items = new Map<string, Record<string, unknown>>();

  const client: DynamoCommandClient = {
    send: (command: unknown) => {
      if (command instanceof PutCommand) {
        const key = command.input.Item?.controlKey as string;
        if (items.has(key))
          throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
        items.set(key, { ...command.input.Item });
        return Promise.resolve({});
      }
      if (command instanceof UpdateCommand) {
        const key = (command.input.Key as { controlKey: string }).controlKey;
        const existing = items.get(key) ?? {};
        const fingerprints =
          (existing.contributedFingerprints as Set<string> | undefined) ?? new Set();
        const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
        const fp = values[':fp'] as string;
        if (fingerprints.has(fp)) {
          throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
        }
        const entry = (values[':entry'] as unknown[])[0];
        const updated = {
          ...existing,
          completedCount: ((existing.completedCount as number | undefined) ?? 0) + 1,
          results: [...((existing.results as unknown[] | undefined) ?? []), entry],
          contributedFingerprints: new Set([...fingerprints, fp]),
        };
        items.set(key, updated);
        return Promise.resolve({ Attributes: updated });
      }
      throw new Error(`UNEXPECTED_COMMAND: ${String(command)}`);
    },
  };
  return { client };
}

const BASE = {
  reportDate: '2026-09-30',
  batchId: 'evt-1',
  slackChannel: 'C1',
  slackThreadTs: '111.222',
  ttlSeconds: 900,
};

describe('DynamoBatchTracker', () => {
  it('only the last of N contributions reports isLast with the full results', async () => {
    const { client } = fakeDynamoTable();
    const tracker = new DynamoBatchTracker(client, 'control');
    await tracker.createBatch({ ...BASE, expectedCount: 3 });

    const first = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-a',
      entry: { lineLabel: 'A', lineFingerprint: 'fp-a', status: 'completed' },
    });
    const second = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-b',
      entry: {
        lineLabel: 'B',
        lineFingerprint: 'fp-b',
        status: 'failed',
        reason: 'WORKFLOW_ERROR',
      },
    });
    const third = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-c',
      entry: { lineLabel: 'C', lineFingerprint: 'fp-c', status: 'completed' },
    });

    expect(first.isLast).toBe(false);
    expect(second.isLast).toBe(false);
    expect(third.isLast).toBe(true);
    expect(third.batch?.results).toEqual([
      { lineLabel: 'A', lineFingerprint: 'fp-a', status: 'completed' },
      { lineLabel: 'B', lineFingerprint: 'fp-b', status: 'failed', reason: 'WORKFLOW_ERROR' },
      { lineLabel: 'C', lineFingerprint: 'fp-c', status: 'completed' },
    ]);
  });

  it('a repeated contribution for the same fingerprint does not double-count', async () => {
    const { client } = fakeDynamoTable();
    const tracker = new DynamoBatchTracker(client, 'control');
    await tracker.createBatch({ ...BASE, expectedCount: 2 });

    const entry = { lineLabel: 'A', lineFingerprint: 'fp-a', status: 'completed' as const };
    const first = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-a',
      entry,
    });
    // Simulates a Step Functions task retry re-invoking the same terminal
    // Lambda for the same line.
    const retry = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-a',
      entry,
    });

    expect(first.isLast).toBe(false);
    expect(retry.isLast).toBe(false);

    const second = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-b',
      entry: { lineLabel: 'B', lineFingerprint: 'fp-b', status: 'completed' },
    });
    // Only 2 genuine contributions ever counted, so the second distinct line
    // is correctly the last one home, not stuck waiting on a phantom third.
    expect(second.isLast).toBe(true);
    expect(second.batch?.results).toHaveLength(2);
  });

  it('creating the same batch twice is a no-op — the original expectedCount sticks', async () => {
    const { client } = fakeDynamoTable();
    const tracker = new DynamoBatchTracker(client, 'control');
    await tracker.createBatch({ ...BASE, expectedCount: 5 });
    // A redelivered Slack event for the same round.
    await tracker.createBatch({ ...BASE, expectedCount: 1 });

    const only = await tracker.contribute({
      reportDate: BASE.reportDate,
      batchId: BASE.batchId,
      lineFingerprint: 'fp-a',
      entry: { lineLabel: 'A', lineFingerprint: 'fp-a', status: 'completed' },
    });
    // Still waiting on 4 more — expectedCount stayed 5, not overwritten to 1.
    expect(only.isLast).toBe(false);
  });
});

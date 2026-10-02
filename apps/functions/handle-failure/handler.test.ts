import { describe, expect, it, vi } from 'vitest';
import { handleFailure } from './handler.js';
import type {
  BatchContributor,
  ConcurrencyReleaser,
  LockReleaser,
} from '../persist-result/handler.js';

describe('handleFailure', () => {
  it('releases every concurrency scope and the lock, and never throws on the release path', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(true);
    const contribute = vi.fn().mockResolvedValue({ isLast: false });
    const locks: LockReleaser = { releaseLock };
    const concurrency: ConcurrencyReleaser = { release };
    const batches: BatchContributor = { contribute };

    const result = await handleFailure(
      {
        reportDate: '2026-09-24',
        lineFingerprint: 'fp-1',
        lineLabel: 'Total AWS',
        ownerToken: 'cost-abc',
        batchId: 'evt-1',
        expectedCount: 3,
        reason: 'WORKFLOW_ERROR',
        errorMessage: 'raw stack trace, never logged verbatim',
      },
      locks,
      concurrency,
      batches,
    );

    expect(result).toEqual({ released: true, batchComplete: false });
    expect(release).toHaveBeenCalledWith('CONC#GLOBAL', 'cost-abc');
    expect(release).toHaveBeenCalledWith('CONC#REPORT#2026-09-24', 'cost-abc');
    expect(releaseLock).toHaveBeenCalledWith('fp-1', 'cost-abc');
    expect(contribute).toHaveBeenCalledWith({
      reportDate: '2026-09-24',
      batchId: 'evt-1',
      lineFingerprint: 'fp-1',
      entry: {
        lineLabel: 'Total AWS',
        lineFingerprint: 'fp-1',
        status: 'failed',
        reason: 'WORKFLOW_ERROR',
      },
    });
  });

  it('returns the full batch when this failure is the last contribution', async () => {
    const locks: LockReleaser = { releaseLock: vi.fn().mockResolvedValue(true) };
    const concurrency: ConcurrencyReleaser = { release: vi.fn().mockResolvedValue(undefined) };
    const batch = {
      results: [
        { lineLabel: 'A', lineFingerprint: 'fp-a', status: 'completed' as const },
        {
          lineLabel: 'B',
          lineFingerprint: 'fp-1',
          status: 'failed' as const,
          reason: 'WORKFLOW_ERROR',
        },
      ],
    };
    const batches: BatchContributor = {
      contribute: vi.fn().mockResolvedValue({ isLast: true, batch }),
    };

    const result = await handleFailure(
      {
        reportDate: '2026-09-24',
        lineFingerprint: 'fp-1',
        lineLabel: 'B',
        ownerToken: 'cost-abc',
        batchId: 'evt-1',
        expectedCount: 2,
        reason: 'WORKFLOW_ERROR',
      },
      locks,
      concurrency,
      batches,
    );

    expect(result).toEqual({
      released: true,
      batchComplete: true,
      batch: { lines: batch.results },
    });
  });
});

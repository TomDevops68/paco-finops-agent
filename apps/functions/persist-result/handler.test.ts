import { describe, expect, it, vi } from 'vitest';
import {
  persistResult,
  type MemoryWriter,
  type ConcurrencyReleaser,
  type LockReleaser,
  type BatchContributor,
} from './handler.js';
import type { FinalCostAnalysis } from '../../../packages/schemas/src/index.js';

const analysis: FinalCostAnalysis = {
  classification: 'GENERIC',
  status: 'HYPOTHESIS_ONLY',
  summary: 'x',
  driver: null,
  confidence: 0.4,
  evidence: [],
  hypotheses: [],
  rejectedHypotheses: [],
  savingsRecommendations: [],
  limitations: [],
  serviceBreakdown: [],
  rootCauseEvidence: [],
  recommendedActions: [],
};

describe('persistResult', () => {
  it('writes the memory record, releases the global/report concurrency reservations and the lock, and contributes to the batch', async () => {
    const putPriorAnalysis = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const contribute = vi.fn().mockResolvedValue({ isLast: false });
    const memory: MemoryWriter = { putPriorAnalysis };
    const locks: LockReleaser = { releaseLock };
    const concurrency: ConcurrencyReleaser = { release };
    const batches: BatchContributor = { contribute };

    const result = await persistResult(
      {
        reportDate: '2026-09-24',
        lineFingerprint: 'fp-1',
        lineLabel: 'Total AWS',
        ownerToken: 'cost-abc',
        batchId: 'evt-1',
        expectedCount: 3,
        analysis,
        memoryRetentionSeconds: 604_800,
      },
      memory,
      locks,
      concurrency,
      batches,
    );

    expect(result).toEqual({ persisted: true, batchComplete: false });
    expect(putPriorAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ lineFingerprint: 'fp-1', value: analysis }),
    );
    expect(release).toHaveBeenCalledWith('CONC#GLOBAL', 'cost-abc');
    expect(release).toHaveBeenCalledWith('CONC#REPORT#2026-09-24', 'cost-abc');
    expect(releaseLock).toHaveBeenCalledWith('fp-1', 'cost-abc');
    expect(contribute).toHaveBeenCalledWith({
      reportDate: '2026-09-24',
      batchId: 'evt-1',
      lineFingerprint: 'fp-1',
      entry: { lineLabel: 'Total AWS', lineFingerprint: 'fp-1', status: 'completed' },
    });
  });

  it('returns the full batch when this line is the last contribution', async () => {
    const memory: MemoryWriter = { putPriorAnalysis: vi.fn().mockResolvedValue(undefined) };
    const locks: LockReleaser = { releaseLock: vi.fn().mockResolvedValue(true) };
    const concurrency: ConcurrencyReleaser = { release: vi.fn().mockResolvedValue(undefined) };
    const batch = {
      results: [{ lineLabel: 'Total AWS', lineFingerprint: 'fp-1', status: 'completed' as const }],
    };
    const batches: BatchContributor = {
      contribute: vi.fn().mockResolvedValue({ isLast: true, batch }),
    };

    const result = await persistResult(
      {
        reportDate: '2026-09-24',
        lineFingerprint: 'fp-1',
        lineLabel: 'Total AWS',
        ownerToken: 'cost-abc',
        batchId: 'evt-1',
        expectedCount: 1,
        analysis,
        memoryRetentionSeconds: 604_800,
      },
      memory,
      locks,
      concurrency,
      batches,
    );

    expect(result).toEqual({
      persisted: true,
      batchComplete: true,
      batch: { lines: batch.results },
    });
  });
});

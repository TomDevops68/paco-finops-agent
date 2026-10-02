import { describe, expect, it, vi } from 'vitest';
import {
  formatNotification,
  notifySlack,
  splitForSlack,
  type ReportCompleteLine,
  type SlackNotifier,
  type ThreadLookup,
} from './handler.js';
import type { FinalCostAnalysis } from '../../../packages/schemas/src/index.js';

const analysis: FinalCostAnalysis = {
  classification: 'USAGE_GROWTH',
  status: 'LIKELY_DRIVER_IDENTIFIED',
  summary: 'Bedrock Nova Lite usage grew.',
  driver: 'Increased token volume.',
  confidence: 0.85,
  evidence: [],
  hypotheses: [],
  rejectedHypotheses: [],
  savingsRecommendations: [
    {
      action: 'Migrate to Fargate Spot',
      lever: 'fargate-spot-migrator',
      estimatedMonthlySavingsUsd: 42.5,
      supportingEvidenceIds: [],
      requiresHumanApproval: true,
    },
  ],
  limitations: ['Resource-level evidence could not be verified.'],
  serviceBreakdown: [],
  rootCauseEvidence: [
    { statement: 'API Gateway requests rose 116x over baseline.', supportingEvidenceIds: ['ev-1'] },
  ],
  recommendedActions: [],
};

function completedLine(
  overrides: Partial<ReportCompleteLine & { status: 'completed' }> = {},
): ReportCompleteLine {
  return {
    lineLabel: 'Bedrock Nova Lite',
    lineFingerprint: 'fp-1',
    status: 'completed' as const,
    analysis,
    ...overrides,
  };
}

describe('formatNotification', () => {
  it('formats a report_complete message headed by a bold report-date headline', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine()],
    });
    expect(text.split('\n')[0]).toBe('*Cost report 2026-09-24*');
  });

  it('renders one merged Conclusion paragraph per line, not a full section per line', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [
        completedLine({ lineLabel: 'Total AWS' }),
        completedLine({
          lineLabel: 'Blinx - Management Account',
          analysis: { ...analysis, driver: 'Flat run-rate.' },
        }),
      ],
    });
    expect(text).toContain('Conclusion');
    expect(text).toContain('Total AWS: Increased token volume.');
    expect(text).toContain('Blinx - Management Account: Flat run-rate.');
    // Only one "Conclusion" header, not one per line.
    expect(text.match(/^\*Conclusion\*$/gm)).toHaveLength(1);
  });

  it('falls back to summary for a line conclusion when driver is null', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine({ analysis: { ...analysis, driver: null } })],
    });
    expect(text).toContain('Bedrock Nova Lite usage grew.');
  });

  it('shows a failed line as a one-line Conclusion paragraph with its reason', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [
        {
          lineLabel: 'Total AWS',
          lineFingerprint: 'fp-3',
          status: 'failed',
          reason: 'WORKFLOW_ERROR',
        },
      ],
    });
    expect(text).toContain('Total AWS: investigation did not complete (WORKFLOW_ERROR).');
  });

  it('falls back to a generic reason for a failed line with none given', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [{ lineLabel: 'Total AWS', lineFingerprint: 'fp-3', status: 'failed' }],
    });
    expect(text).toContain('Total AWS: investigation did not complete (unknown error).');
  });

  it('drops status/confidence/limitations from the merged message', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine()],
    });
    expect(text).not.toContain('Bedrock Nova Lite usage grew.');
    expect(text).not.toContain('LIKELY_DRIVER_IDENTIFIED');
    expect(text).not.toContain('Resource-level evidence could not be verified.');
    expect(text).not.toContain('Evidence checked:');
  });

  it('never renders a Breakdown by service, Cost comparison, Root cause evidence, or Savings recommendations section — kept short and focused', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine()],
    });
    expect(text).not.toContain('Breakdown by service');
    expect(text).not.toContain('Cost comparison:');
    expect(text).not.toContain('Root cause evidence:');
    expect(text).not.toContain('Savings recommendations:');
    expect(text).not.toContain('API Gateway requests rose 116x over baseline.');
    expect(text).not.toContain('Fargate Spot');
  });

  it('merges recommended actions into one section, each paragraph labeled with its line', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [
        completedLine({
          lineLabel: 'Total AWS',
          analysis: {
            ...analysis,
            recommendedActions: [
              { action: 'Verify the nhs-prod scale-out.', supportingEvidenceIds: [] },
            ],
          },
        }),
        completedLine({
          lineLabel: 'Blinx - Management Account',
          analysis: {
            ...analysis,
            recommendedActions: [{ action: 'No remediation required.', supportingEvidenceIds: [] }],
          },
        }),
      ],
    });
    expect(text.match(/^\*Recommended Actions\*$/gm)).toHaveLength(1);
    expect(text).toContain('Total AWS: Verify the nhs-prod scale-out.');
    expect(text).toContain('Blinx - Management Account: No remediation required.');
  });

  it('prefixes an up-trend line with the red up icon', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine({ trendDirection: 'up' })],
    });
    expect(text).toContain(':red_circle::arrow_up: Bedrock Nova Lite: Increased token volume.');
  });

  it('prefixes a down-trend line with the green down icon', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine({ trendDirection: 'down' })],
    });
    expect(text).toContain(
      ':large_green_circle::arrow_down: Bedrock Nova Lite: Increased token volume.',
    );
  });

  it('adds no icon for flat/new trends or when trend is unknown', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine()],
    });
    expect(text).toContain('Bedrock Nova Lite: Increased token volume.');
    expect(text).not.toContain(':red_circle:');
    expect(text).not.toContain(':large_green_circle:');
  });

  it('prefixes a failed line with its trend icon too', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [
        {
          lineLabel: 'Total AWS',
          lineFingerprint: 'fp-3',
          status: 'failed',
          reason: 'WORKFLOW_ERROR',
          trendDirection: 'up',
        },
      ],
    });
    expect(text).toContain(
      ':red_circle::arrow_up: Total AWS: investigation did not complete (WORKFLOW_ERROR).',
    );
  });

  it('omits the recommended actions section when no line has any', () => {
    const text = formatNotification({
      kind: 'report_complete',
      reportDate: '2026-09-24',
      lines: [completedLine()],
    });
    expect(text).not.toContain('Recommended Actions');
  });
});

describe('splitForSlack', () => {
  it('returns a single chunk for text under the limit', () => {
    expect(splitForSlack('short text', 100)).toEqual(['short text']);
  });

  it('splits long text on line boundaries without exceeding the limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i)} `.repeat(5));
    const text = lines.join('\n');
    const chunks = splitForSlack(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(80 + 20);
    expect(chunks.join('\n')).toBe(text);
  });

  it('never splits inside a fenced code block, even if that chunk exceeds the limit', () => {
    const text = [
      'before',
      '```',
      'a very long command that exceeds the limit on its own',
      '```',
      'after',
    ].join('\n');
    const chunks = splitForSlack(text, 10);
    const fenceChunk = chunks.find((chunk) => chunk.includes('a very long command'));
    expect(fenceChunk).toContain('```\na very long command that exceeds the limit on its own\n```');
  });
});

describe('notifySlack', () => {
  it('does not post when the report has no claimed thread', async () => {
    const threads: ThreadLookup = { getThread: vi.fn().mockResolvedValue(undefined) };
    const postMessage = vi.fn();
    const slack: SlackNotifier = { postMessage };
    const result = await notifySlack(
      {
        kind: 'report_complete',
        reportDate: '2026-09-24',
        lines: [completedLine()],
        channel: 'C1',
      },
      threads,
      slack,
    );
    expect(result).toEqual({ posted: false, reason: 'NO_THREAD' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts into the claimed thread', async () => {
    const threads: ThreadLookup = { getThread: vi.fn().mockResolvedValue({ threadTs: '123.456' }) };
    const postMessage = vi.fn().mockResolvedValue({ ts: '789.012' });
    const slack: SlackNotifier = { postMessage };
    const result = await notifySlack(
      {
        kind: 'report_complete',
        reportDate: '2026-09-24',
        lines: [completedLine()],
        channel: 'C1',
      },
      threads,
      slack,
    );
    expect(result).toEqual({ posted: true, ts: '789.012' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', thread_ts: '123.456' }),
    );
  });

  it('splits a long consolidated report across multiple posts into the same thread, returning the last ts', async () => {
    const threads: ThreadLookup = { getThread: vi.fn().mockResolvedValue({ threadTs: '123.456' }) };
    let callCount = 0;
    const postMessage = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({ ts: `${String(callCount)}.000` });
    });
    const slack: SlackNotifier = { postMessage };
    const lines: ReportCompleteLine[] = Array.from({ length: 40 }, (_, i) =>
      completedLine({
        lineLabel: `Account ${String(i)}`,
        lineFingerprint: `fp-${String(i)}`,
        analysis: {
          ...analysis,
          recommendedActions: [
            {
              action: `Recommendation ${String(i)}, a fairly wordy action description here to pad length`,
              supportingEvidenceIds: [],
            },
          ],
        },
      }),
    );
    const result = await notifySlack(
      { kind: 'report_complete', reportDate: '2026-09-24', lines, channel: 'C1' },
      threads,
      slack,
    );
    expect(postMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of postMessage.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ channel: 'C1', thread_ts: '123.456' }));
      expect((call[0] as { text: string }).text.length).toBeLessThanOrEqual(3_500 + 100);
    }
    expect(result).toEqual({ posted: true, ts: `${String(callCount)}.000` });
  });
});

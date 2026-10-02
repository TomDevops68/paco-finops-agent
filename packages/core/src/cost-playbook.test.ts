import { describe, expect, it } from 'vitest';
import { classifySignificance, isNotable } from './cost-playbook.js';
import type { CostReportLine } from '../../schemas/src/index.js';

function line(overrides: Partial<CostReportLine>): CostReportLine {
  return {
    label: 'Total AWS',
    kind: 'total',
    yesterdayUsd: 100,
    trend: { direction: 'flat', percent: 0 },
    currentUsd: 1000,
    ...overrides,
  };
}

describe('classifySignificance', () => {
  it('maps each trend direction to its significance', () => {
    expect(classifySignificance(line({ trend: { direction: 'new', percent: 0 } }))).toBe('new');
    expect(classifySignificance(line({ trend: { direction: 'up', percent: 20 } }))).toBe(
      'increase',
    );
    expect(classifySignificance(line({ trend: { direction: 'down', percent: 20 } }))).toBe(
      'decrease',
    );
    expect(classifySignificance(line({ trend: { direction: 'flat', percent: 0.1 } }))).toBe(
      'unchanged',
    );
  });
});

describe('isNotable', () => {
  const thresholds = { significantChangePercent: 10 };

  it('is always notable when brand new, regardless of percent', () => {
    expect(isNotable(line({ trend: { direction: 'new', percent: 0 } }), thresholds)).toBe(true);
  });

  it('is notable when the trend magnitude meets the threshold', () => {
    expect(isNotable(line({ trend: { direction: 'up', percent: 10 } }), thresholds)).toBe(true);
    expect(isNotable(line({ trend: { direction: 'down', percent: 11.2 } }), thresholds)).toBe(true);
  });

  it('is not notable below the threshold', () => {
    expect(isNotable(line({ trend: { direction: 'down', percent: 5.1 } }), thresholds)).toBe(false);
    expect(isNotable(line({ trend: { direction: 'flat', percent: 0 } }), thresholds)).toBe(false);
  });

  it('is never notable when its label is excluded, even when brand new or over threshold', () => {
    const excluding = { ...thresholds, excludedLabels: ['Bedrock Nova Lite'] };
    expect(
      isNotable(
        line({ label: 'Bedrock Nova Lite', trend: { direction: 'new', percent: 0 } }),
        excluding,
      ),
    ).toBe(false);
    expect(
      isNotable(
        line({ label: 'Bedrock Nova Lite', trend: { direction: 'up', percent: 50 } }),
        excluding,
      ),
    ).toBe(false);
    // A different label is unaffected by the exclusion list.
    expect(
      isNotable(line({ label: 'Total AWS', trend: { direction: 'new', percent: 0 } }), excluding),
    ).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { parseCostReportBlocks, parseCostReportText } from './cost-message-parser.js';

/** Mirrors `paco-daily-cost-report/lambda/index.py`'s `ACCOUNT_MAP`. */
const ACCOUNT_MAP = {
  '025031850414': 'Blinx - Management Account',
  '510825518696': 'PACO - Production',
  '680099409919': 'PACO - Non-Production',
};

// Exact production message pasted by the user (2026-09-24, Slack UI copy —
// blocks run together with no separator, bold/backticks stripped). This is
// the real-world shape `parseCostReportText` exists to handle.
const FLATTENED_MESSAGE =
  'Cloud Spending Analysis - 2026-09-24AWS Accounts SummaryTotal AWS | Yesterday: $2,782.88 ' +
  ':chart_with_downwards_trend:11.2% | Current: $108,045.38 | Forecast: $123,728.23' +
  '• Bedrock Nova Lite | Yesterday: $0.00 NEW0% | Current: $0.00' +
  '• Blinx - Management Account | Yesterday: $273.05 :chart_with_downwards_trend:5.1% | Current: $34,892.32 | Forecast: $36,596.10' +
  '• PACO - Production | Yesterday: $1,844.47 :chart_with_downwards_trend:13.5% | Current: $53,562.50 | Forecast: $64,550.89' +
  '• PACO - Non-Production | Yesterday: $585.55 :chart_with_downwards_trend:5.2% | Current: $15,616.18 | Forecast: $19,215.74';

const HEADER_BLOCK = {
  type: 'header',
  text: { type: 'plain_text', text: 'Cloud Spending Analysis - 2026-09-24' },
};

// Byte-accurate reconstruction of the Block Kit blocks paco-daily-cost-report
// actually posts (see its `handler()`), for the primary blocks-based parser.
const BLOCKS = [
  HEADER_BLOCK,
  { type: 'section', text: { type: 'mrkdwn', text: '*AWS Accounts Summary*' } },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Total AWS* | Yesterday: `$2,782.88` :chart_with_downwards_trend:11.2% | Current: `$108,045.38` | Forecast: `$123,728.23`',
    },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '• *Bedrock Nova Lite* | Yesterday: `$0.00` NEW0% | Current: `$0.00`',
    },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '• *Blinx - Management Account* | Yesterday: `$273.05` :chart_with_downwards_trend:5.1% | Current: `$34,892.32` | Forecast: `$36,596.10`',
    },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '• *PACO - Production* | Yesterday: `$1,844.47` :chart_with_downwards_trend:13.5% | Current: `$53,562.50` | Forecast: `$64,550.89`',
    },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '• *PACO - Non-Production* | Yesterday: `$585.55` :chart_with_downwards_trend:5.2% | Current: `$15,616.18` | Forecast: `$19,215.74`',
    },
  },
];

describe('parseCostReportBlocks', () => {
  it('parses the real Block Kit message into a NormalizedCostReport', () => {
    const result = parseCostReportBlocks(BLOCKS, ACCOUNT_MAP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.reportDate).toBe('2026-09-24');
    expect(result.report.lines).toHaveLength(5);

    const total = result.report.lines[0];
    expect(total).toEqual({
      label: 'Total AWS',
      kind: 'total',
      yesterdayUsd: 2782.88,
      trend: { direction: 'down', percent: 11.2 },
      currentUsd: 108045.38,
      forecastUsd: 123728.23,
    });

    const novaLite = result.report.lines[1];
    expect(novaLite).toEqual({
      label: 'Bedrock Nova Lite',
      kind: 'service',
      yesterdayUsd: 0,
      trend: { direction: 'new', percent: 0 },
      currentUsd: 0,
    });

    const management = result.report.lines[2];
    expect(management?.kind).toBe('account');
    expect(management?.accountId).toBe('025031850414');

    const prod = result.report.lines[3];
    expect(prod?.accountId).toBe('510825518696');
    expect(prod?.trend).toEqual({ direction: 'down', percent: 13.5 });

    const nonProd = result.report.lines[4];
    expect(nonProd?.accountId).toBe('680099409919');
  });

  it('leaves accountId unset for an account line not present in the account map', () => {
    const result = parseCostReportBlocks(BLOCKS, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const management = result.report.lines.find(
      (line) => line.label === 'Blinx - Management Account',
    );
    expect(management?.kind).toBe('account');
    expect(management?.accountId).toBeUndefined();
  });

  it('fails closed when the header date is missing', () => {
    const result = parseCostReportBlocks(BLOCKS.slice(1), ACCOUNT_MAP);
    expect(result).toEqual({
      ok: false,
      reason: 'Could not find a "Cloud Spending Analysis - <date>" header',
    });
  });

  it('fails closed when no section block matches a cost line', () => {
    const result = parseCostReportBlocks([HEADER_BLOCK], ACCOUNT_MAP);
    expect(result).toEqual({ ok: false, reason: 'Could not find any cost lines in the message' });
  });
});

describe('parseCostReportText', () => {
  it('parses the flattened, separator-free Slack-copy text into the same report', () => {
    const result = parseCostReportText(FLATTENED_MESSAGE, ACCOUNT_MAP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.reportDate).toBe('2026-09-24');
    expect(result.report.lines).toHaveLength(5);
    expect(result.report.lines.map((line) => line.label)).toEqual([
      'Total AWS',
      'Bedrock Nova Lite',
      'Blinx - Management Account',
      'PACO - Production',
      'PACO - Non-Production',
    ]);
    expect(result.report.lines[0]?.currentUsd).toBe(108045.38);
    expect(result.report.lines[1]?.trend).toEqual({ direction: 'new', percent: 0 });
    expect(result.report.lines[3]?.accountId).toBe('510825518696');
  });

  it('fails closed when there is no "Total AWS" line', () => {
    const result = parseCostReportText(
      'Cloud Spending Analysis - 2026-09-24 nothing useful here',
      ACCOUNT_MAP,
    );
    expect(result).toEqual({ ok: false, reason: 'Could not find a "Total AWS" line' });
  });
});

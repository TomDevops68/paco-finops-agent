import type { CostReportLine, NormalizedCostReport } from '../../schemas/src/index.js';

export type CostReportParseResult =
  | { ok: true; report: NormalizedCostReport }
  | { ok: false; reason: string };

/** id -> display name, mirroring `paco-daily-cost-report`'s `ACCOUNT_MAP`. */
export type CostAccountMap = Record<string, string>;

const DATE_RE = /Cloud Spending Analysis\s*-\s*(\d{4}-\d{2}-\d{2})/;

// Matches one report line in either of its two real-world shapes:
//  1. A single Slack Block Kit block's raw mrkdwn text, e.g.
//     "*Total AWS* | Yesterday: `$2,782.88` :chart_with_downwards_trend:11.2% | Current: `$108,045.38` | Forecast: `$123,728.23`"
//     or "• *Bedrock Nova Lite* | Yesterday: `$0.00` NEW0% | Current: `$0.00`"
//  2. A segment of the flattened, separator-free text Slack produces when a
//     Block-Kit-only message is copied out of the UI (bold/backticks
//     stripped, blocks run together with no whitespace between them) — see
//     `parseCostReportText`, which pre-splits that text into segments before
//     this regex ever sees them.
// The trend marker is required, not optional: `get_trend_info()` in the
// source Lambda always emits either an icon or the literal "NEW", so a line
// missing both is unrecognized input, not a line with a default trend.
const LINE_RE =
  /^(?:•\s*)?\*?(?<label>[^|*]+?)\*?\s*\|\s*Yesterday:\s*`?\$(?<yesterday>[\d,]+\.\d{2})`?\s*(?:(?<trendIcon>:[a-z_]+:)|(?<trendWord>NEW))(?<trendPct>\d+(?:\.\d+)?)%\s*\|\s*Current:\s*`?\$(?<current>[\d,]+\.\d{2})`?(?:\s*\|\s*Forecast:\s*`?\$(?<forecast>[\d,]+\.\d{2})`?)?\s*$/;

function parseUsd(raw: string): number {
  return Number.parseFloat(raw.replace(/,/g, ''));
}

function trendDirection(iconOrWord: {
  icon: string | undefined;
  word: string | undefined;
}): CostReportLine['trend']['direction'] {
  if (iconOrWord.word === 'NEW') return 'new';
  if (iconOrWord.icon === ':chart_with_upwards_trend:') return 'up';
  if (iconOrWord.icon === ':chart_with_downwards_trend:') return 'down';
  return 'flat';
}

function reverseAccountMap(accountMap: CostAccountMap): Map<string, string> {
  const byName = new Map<string, string>();
  for (const [id, name] of Object.entries(accountMap)) byName.set(name.trim().toLowerCase(), id);
  return byName;
}

/**
 * Parses one report line (see `LINE_RE` above). Returns `undefined`, not an
 * error, for text that isn't a cost line at all (a divider block, the
 * "AWS Accounts Summary" label, stray whitespace) — callers treat that as
 * "skip this segment", matching every other parser in this codebase that
 * never throws on untrusted external text.
 */
function parseLine(raw: string, accountsByName: Map<string, string>): CostReportLine | undefined {
  const match = LINE_RE.exec(raw.trim());
  if (!match?.groups) return undefined;
  const g = match.groups;
  const label = g.label?.trim();
  const yesterday = g.yesterday;
  const current = g.current;
  const trendPct = g.trendPct;
  if (!label || !yesterday || !current || !trendPct) return undefined;

  const forecastUsd = g.forecast ? parseUsd(g.forecast) : undefined;
  const kind: CostReportLine['kind'] =
    label === 'Total AWS' ? 'total' : forecastUsd !== undefined ? 'account' : 'service';
  const accountId = kind === 'account' ? accountsByName.get(label.trim().toLowerCase()) : undefined;

  return {
    label,
    kind,
    ...(accountId ? { accountId } : {}),
    yesterdayUsd: parseUsd(yesterday),
    trend: {
      direction: trendDirection({ icon: g.trendIcon, word: g.trendWord }),
      percent: Number.parseFloat(trendPct),
    },
    currentUsd: parseUsd(current),
    ...(forecastUsd !== undefined ? { forecastUsd } : {}),
  };
}

function buildReport(
  dateMatch: RegExpExecArray | null,
  lines: CostReportLine[],
): CostReportParseResult {
  const reportDate = dateMatch?.[1];
  if (!reportDate) {
    return { ok: false, reason: 'Could not find a "Cloud Spending Analysis - <date>" header' };
  }
  if (lines.length === 0) {
    return { ok: false, reason: 'Could not find any cost lines in the message' };
  }
  return { ok: true, report: { reportDate, lines } };
}

/**
 * Primary parser: takes the thread root message's Slack Block Kit `blocks`
 * (from `SlackWebApiClient.getThreadRoot`) and extracts each block's own
 * mrkdwn/plain_text independently — sidestepping the flattened-text
 * ambiguity entirely, since block boundaries are unambiguous in the API
 * response even though they're lost once rendered/copied as plain text.
 */
export function parseCostReportBlocks(
  blocks: readonly { type: string; text?: { type: string; text: string } }[],
  accountMap: CostAccountMap = {},
): CostReportParseResult {
  const accountsByName = reverseAccountMap(accountMap);
  const headerText = blocks.find((block) => block.type === 'header')?.text?.text ?? '';
  const dateMatch = DATE_RE.exec(headerText);

  const lines: CostReportLine[] = [];
  for (const block of blocks) {
    if (block.type !== 'section' || !block.text?.text) continue;
    const line = parseLine(block.text.text, accountsByName);
    if (line) lines.push(line);
  }
  return buildReport(dateMatch, lines);
}

/**
 * Fallback parser for a flattened, separator-free copy of the message (e.g.
 * pasted out of the Slack UI, where Block-Kit-only messages run together
 * with no whitespace between blocks: `...Forecast: $123,728.23• Bedrock...`).
 * Real-world fixture: the exact "Cloud Spending Analysis - 2026-09-24"
 * message this parser was built against. Splitting on the literal "•"
 * bullet is unambiguous because it never appears inside a line's own text.
 */
export function parseCostReportText(
  text: string,
  accountMap: CostAccountMap = {},
): CostReportParseResult {
  const accountsByName = reverseAccountMap(accountMap);
  const dateMatch = DATE_RE.exec(text);

  const totalIndex = text.indexOf('Total AWS');
  if (totalIndex === -1) {
    return { ok: false, reason: 'Could not find a "Total AWS" line' };
  }
  const segments = text
    .slice(totalIndex)
    .split('•')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const lines: CostReportLine[] = [];
  for (const segment of segments) {
    const line = parseLine(segment, accountsByName);
    if (line) lines.push(line);
  }
  return buildReport(dateMatch, lines);
}

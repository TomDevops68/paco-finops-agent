import type { FinalCostAnalysis } from '../../../packages/schemas/src/index.js';

// One notable line's outcome within a report round's consolidated message.
// `analysis` is present only when status is 'completed' — a 'failed' line
// (this line's own Step Functions execution ended via handle-failure) never
// had a validated analysis to show.
export type ReportCompleteLine =
  | {
      lineLabel: string;
      lineFingerprint: string;
      status: 'completed';
      analysis?: FinalCostAnalysis;
      trendDirection?: 'up' | 'down' | 'flat' | 'new';
    }
  | {
      lineLabel: string;
      lineFingerprint: string;
      status: 'failed';
      reason?: string;
      trendDirection?: 'up' | 'down' | 'flat' | 'new';
    };

export type NotifyInput =
  | { kind: 'known_line_reused'; reportDate: string; lineLabel: string }
  | { kind: 'failed'; reportDate: string; lineLabel: string; reason: string }
  | { kind: 'report_complete'; reportDate: string; lines: ReportCompleteLine[] };

export interface ThreadLookup {
  getThread(reportDate: string): Promise<{ threadTs: string } | undefined>;
}

export interface SlackNotifier {
  postMessage(input: { channel: string; text: string; thread_ts: string }): Promise<{ ts: string }>;
}

// The narrative explanation, not a data point — says *why* the cost moved.
// Falls back to `summary` when the model had no specific driver (e.g.
// INSUFFICIENT_EVIDENCE). Whitespace-collapsed defensively against stray
// formatting in the model's own text, but no longer forced onto one line — a
// short paragraph (2-4 sentences) is expected here.
function formatConclusion(analysis: FinalCostAnalysis): string | undefined {
  const text = (analysis.driver ?? analysis.summary).trim().replace(/\s+/g, ' ');
  return text || undefined;
}

// Cost is the metric, not the stock price: a rising cost is bad (red), a
// falling cost is good (green) — the reverse of the usual chart-emoji
// convention, so plain up/down arrows are used instead of 📈/📉. 'flat'/'new'
// get no icon since neither direction reads as clearly good or bad.
function formatTrendIcon(direction: 'up' | 'down' | 'flat' | 'new' | undefined): string {
  switch (direction) {
    case 'up':
      return ':red_circle::arrow_up: ';
    case 'down':
      return ':large_green_circle::arrow_down: ';
    default:
      return '';
  }
}

// Every one of these `formatMerged*` functions produces ONE section shared
// across every investigated line, not one full report repeated per line —
// each paragraph is instead labeled with which account/line it came from.
// This is a purely mechanical merge (no additional AI call): each line's own
// independently-gathered evidence is regrouped by section, never combined
// or re-derived. Plain paragraphs, no bullets — kept as short and plain as
// possible per spec.
function formatMergedConclusion(lines: readonly ReportCompleteLine[]): string[] {
  const paragraphs = lines.map((line) => {
    const icon = formatTrendIcon(line.trendDirection);
    if (line.status === 'failed') {
      return `${icon}${line.lineLabel}: investigation did not complete (${line.reason ?? 'unknown error'}).`;
    }
    const conclusion = line.analysis ? formatConclusion(line.analysis) : undefined;
    return `${icon}${line.lineLabel}: ${conclusion ?? 'no conclusion available.'}`;
  });
  return ['*Conclusion*', ...paragraphs];
}

function formatMergedRecommendedActions(lines: readonly ReportCompleteLine[]): string[] {
  const paragraphs = lines.flatMap((line) => {
    if (line.status !== 'completed' || !line.analysis) return [];
    return line.analysis.recommendedActions.map((entry) => `${line.lineLabel}: ${entry.action}`);
  });
  if (paragraphs.length === 0) return [];
  return ['*Recommended Actions*', ...paragraphs];
}

/**
 * Every kind posts into the same Slack thread the report lives in — no new
 * top-level message is ever created for a report already being tracked
 * (spec §9's "one thread per report date"). `report_complete` is the single
 * consolidated message for a whole report round: one Conclusion (the why,
 * vs. yesterday) / Recommended Actions section covering every investigated
 * line together — short and focused by design, not a separate full report
 * repeated per line.
 */
export function formatNotification(input: NotifyInput): string {
  switch (input.kind) {
    case 'known_line_reused':
      return `*${input.lineLabel}* (${input.reportDate}) was already investigated recently — reusing that analysis.`;
    case 'failed':
      return `Investigation of *${input.lineLabel}* (${input.reportDate}) did not complete: ${input.reason}`;
    case 'report_complete': {
      const header = `*Cost report ${input.reportDate}*`;
      const sections = [
        formatMergedConclusion(input.lines),
        formatMergedRecommendedActions(input.lines),
      ].filter((section) => section.length > 0);
      return [header, ...sections.map((section) => section.join('\n'))].join('\n\n');
    }
  }
}

// Conservative margin below Slack's practical limit for a plain (non-blocks)
// `chat.postMessage` text — observed live truncating a real analysis message
// at ~3,789 characters with no error. Splits on line boundaries and never
// breaks inside a fenced code block, so a split point never lands mid-fence.
const SLACK_TEXT_SAFE_LIMIT = 3_500;

export function splitForSlack(text: string, limit = SLACK_TEXT_SAFE_LIMIT): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let insideFence = false;
  for (const line of lines) {
    const lineLength = line.length + 1;
    if (currentLength + lineLength > limit && current.length > 0 && !insideFence) {
      chunks.push(current.join('\n'));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += lineLength;
    if (line.trim() === '```') insideFence = !insideFence;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

export async function notifySlack(
  input: NotifyInput & { channel: string },
  threads: ThreadLookup,
  slack: SlackNotifier,
): Promise<{ posted: boolean; ts?: string; reason?: string }> {
  const thread = await threads.getThread(input.reportDate);
  if (!thread) return { posted: false, reason: 'NO_THREAD' };
  // `splitForSlack` never returns an empty array for non-empty input.
  const [firstChunk, ...restChunks] = splitForSlack(formatNotification(input)) as [
    string,
    ...string[],
  ];
  let lastTs = (
    await slack.postMessage({
      channel: input.channel,
      thread_ts: thread.threadTs,
      text: firstChunk,
    })
  ).ts;
  for (const chunk of restChunks) {
    lastTs = (
      await slack.postMessage({ channel: input.channel, thread_ts: thread.threadTs, text: chunk })
    ).ts;
  }
  return { posted: true, ts: lastTs };
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isNotable,
  parseCostReportBlocks,
  parseCostReportText,
  type CostAccountMap,
  type CostSignificanceThresholds,
} from '../../../packages/core/src/index.js';
import {
  coordinateAndEnqueue,
  type AsyncBatchCreator,
  type AsyncConcurrencyBudget,
  type AsyncCostReportRepository,
  type AsyncInvestigationLock,
  type CoordinateAndEnqueueLineResult,
  type InvestigationQueuePublisher,
} from '../../../packages/aws-repositories/src/index.js';
import { SlackAppMentionEnvelopeSchema } from '../../../packages/schemas/src/index.js';
import type { NormalizedCostReport } from '../../../packages/schemas/src/index.js';
import type { SlackBlock } from '../../../packages/slack-connector/src/index.js';

export interface SlackClient {
  postMessage(input: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<{ ts: string }>;
  getThreadRoot(input: {
    channel: string;
    threadTs: string;
  }): Promise<{ text: string; blocks?: SlackBlock[] } | undefined>;
}

export interface SlackThreadRegistry {
  claimThread(reportDate: string, threadTs: string): Promise<boolean>;
}

const REPLAY_WINDOW_SECONDS = 300;

/**
 * HMAC-SHA256 over `v0:{timestamp}:{body}` per Slack's request-signing spec.
 * Ported unchanged from paco-troubleshoot-agent — pure protocol code with no
 * incident/cost-specific coupling.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestampHeader: string;
  signatureHeader: string;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const timestamp = Number(input.timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = (input.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) return false;

  const expected = `v0=${createHmac('sha256', input.signingSecret)
    .update(`v0:${input.timestampHeader}:${input.rawBody}`)
    .digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(input.signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function isUrlVerification(
  value: unknown,
): value is { type: 'url_verification'; challenge: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'url_verification' &&
    typeof (value as { challenge?: unknown }).challenge === 'string'
  );
}

function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

// One upfront ack per report round — no per-line lock/concurrency status
// text here (that was the literal spam the user asked to remove); a single
// consolidated result message follows later in this thread once every
// enqueued line's investigation completes (see notify-slack's
// `report_complete` kind).
function formatReply(
  report: NormalizedCostReport,
  thresholds: CostSignificanceThresholds,
  decisions: readonly CoordinateAndEnqueueLineResult[],
): string {
  const notable = report.lines.filter((line) => isNotable(line, thresholds));
  const summaryLine = `Parsed the ${report.reportDate} cost report (${String(report.lines.length)} line${report.lines.length === 1 ? '' : 's'}).`;
  if (notable.length === 0) {
    return [summaryLine, 'Nothing crossed the notable-change threshold.'].join('\n\n');
  }
  const enqueued = decisions.filter((decision) => decision.enqueueInvestigation);
  const skipped = decisions.length - enqueued.length;
  if (enqueued.length === 0) {
    return [
      summaryLine,
      'All notable lines are already being investigated or at capacity — nothing new started this round.',
    ].join('\n\n');
  }
  const labels = enqueued.map((decision) => `*${decision.line.label}*`).join(', ');
  const body = [
    `Investigating ${String(enqueued.length)} notable line${enqueued.length === 1 ? '' : 's'}: ${labels}. One consolidated update will follow in this thread.`,
    ...(skipped > 0
      ? [
          `(${String(skipped)} line${skipped === 1 ? '' : 's'} skipped this round — already being investigated or at capacity.)`,
        ]
      : []),
  ].join('\n');
  return [summaryLine, body].join('\n\n');
}

export interface HandleSlackEventInput {
  headers: Record<string, string | undefined>;
  rawBody: string;
  signingSecret: string;
  nowMs?: number;
  slack: SlackClient;
  accountMap: CostAccountMap;
  thresholds: CostSignificanceThresholds;
  reports: AsyncCostReportRepository;
  threads: SlackThreadRegistry;
  locks: AsyncInvestigationLock;
  concurrency: AsyncConcurrencyBudget;
  queue: InvestigationQueuePublisher;
  batches: AsyncBatchCreator;
  lockTtlMs: number;
  batchTtlMs: number;
}

export interface HandleSlackEventResult {
  statusCode: number;
  body: string;
}

/**
 * Slack Events API webhook for the cost agent: verify signature → read the
 * tagged thread's root message → parse → upsert the report record and claim
 * the thread → coordinate dedup/cache/lock/concurrency and enqueue an
 * investigation for each notable line that needs one → reply in-thread with
 * what happened. Structurally the same shape as paco-troubleshoot-agent's
 * `handleSlackEvent`, adapted to a per-report-line unit of work instead of
 * per-incident-occurrence (see `packages/core/src/cost-orchestration.ts`'s
 * comment on why this domain doesn't need occurrence-counting).
 */
export async function handleSlackEvent(
  input: HandleSlackEventInput,
): Promise<HandleSlackEventResult> {
  const signature = headerValue(input.headers, 'x-slack-signature');
  const timestamp = headerValue(input.headers, 'x-slack-request-timestamp');
  const signatureValid =
    !!signature &&
    !!timestamp &&
    verifySlackSignature({
      signingSecret: input.signingSecret,
      timestampHeader: timestamp,
      signatureHeader: signature,
      rawBody: input.rawBody,
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    });
  if (!signatureValid) {
    return { statusCode: 401, body: 'invalid signature' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { statusCode: 400, body: 'malformed JSON body' };
  }

  if (isUrlVerification(payload)) {
    return { statusCode: 200, body: JSON.stringify({ challenge: payload.challenge }) };
  }

  const parsedEnvelope = SlackAppMentionEnvelopeSchema.safeParse(payload);
  if (!parsedEnvelope.success) {
    return { statusCode: 400, body: 'unrecognized Slack event shape' };
  }

  const event = parsedEnvelope.data.event;
  const threadTs = event.thread_ts ?? event.ts;

  const root = await input.slack.getThreadRoot({ channel: event.channel, threadTs });
  if (!root) {
    await input.slack.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "Couldn't read the cost report message in this thread.",
    });
    return { statusCode: 200, body: 'ok' };
  }

  const parsed = root.blocks
    ? parseCostReportBlocks(root.blocks, input.accountMap)
    : parseCostReportText(root.text, input.accountMap);

  if (!parsed.ok) {
    await input.slack.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `Couldn't parse a cost report from this thread: ${parsed.reason}`,
    });
    return { statusCode: 200, body: 'ok' };
  }

  const report = parsed.report;
  const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();
  const upsert = await input.reports.upsertReport({
    report,
    sourceEventId: event.ts,
    timestamp: nowIso,
    slackChannel: event.channel,
    slackThreadTs: threadTs,
  });
  // First poster wins — a second `@mention` under the same thread (or a
  // different thread someone tags for the same report date) still resolves
  // to the one thread every notification (`notify-slack`) posts into.
  await input.threads.claimThread(report.reportDate, threadTs);

  const notableLines = report.lines.filter((line) => isNotable(line, input.thresholds));
  const decisions = await coordinateAndEnqueue({
    report,
    notableLines,
    sourceEventId: event.ts,
    lockTtlMs: input.lockTtlMs,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    locks: input.locks,
    concurrency: input.concurrency,
    queue: input.queue,
    batches: input.batches,
    batchTtlMs: input.batchTtlMs,
    slackChannel: event.channel,
    slackThreadTs: threadTs,
  });

  // Slack redelivers the identical event (same `event.ts`) when the first
  // delivery didn't ack within its 3-second window — `upsertReport`'s own
  // idempotency key (keyed on `sourceEventId`) already detects this exact
  // case. `coordinateAndEnqueue` above is safe to re-run either way (lock
  // reacquire-by-same-owner and execution-name collisions are both
  // no-ops), but posting a second identical "Investigating…" ack is not:
  // it's the duplicate spam this check exists to suppress.
  if (!upsert.duplicate) {
    await input.slack.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: formatReply(report, input.thresholds, decisions),
    });
  }
  return { statusCode: 200, body: 'ok' };
}

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  handleSlackEvent,
  verifySlackSignature,
  type HandleSlackEventInput,
  type SlackClient,
  type SlackThreadRegistry,
} from './handler.js';
import type { SlackBlock } from '../../../packages/slack-connector/src/index.js';

const SIGNING_SECRET = 'test-signing-secret';
const ACCOUNT_MAP = { '510825518696': 'PACO - Production' };
const THRESHOLDS = { significantChangePercent: 10 };
const NOW_MS = 1_758_700_800_000; // 2026-09-24T00:00:00Z

function signedHeaders(rawBody: string, timestampSeconds = Math.floor(NOW_MS / 1000)) {
  const timestampHeader = String(timestampSeconds);
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${timestampHeader}:${rawBody}`).digest('hex')}`;
  return { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestampHeader };
}

function appMentionBody(
  overrides: { channel?: string; ts?: string; thread_ts?: string } = {},
): string {
  return JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev123',
    event_time: 1_758_700_800,
    team_id: 'T123',
    event: {
      type: 'app_mention',
      user: 'U123',
      text: '<@U000> explain this',
      channel: overrides.channel ?? 'C123',
      ts: overrides.ts ?? '1758700800.000100',
      ...(overrides.thread_ts ? { thread_ts: overrides.thread_ts } : {}),
    },
  });
}

const BLOCKS: SlackBlock[] = [
  { type: 'header', text: { type: 'plain_text', text: 'Cloud Spending Analysis - 2026-09-24' } },
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
      text: '• *PACO - Production* | Yesterday: `$1,844.47` :chart_with_downwards_trend:13.5% | Current: `$53,562.50` | Forecast: `$64,550.89`',
    },
  },
];

/**
 * Returns named mock functions alongside the fully-wired `HandleSlackEventInput`
 * dependencies, so assertions reference local variables directly instead of
 * object properties — see handler.test.ts in the cost-connectors package for
 * why (`@typescript-eslint/unbound-method`).
 */
function fakeDeps(
  overrides: {
    getThreadRoot?: SlackClient['getThreadRoot'];
    lockAcquirable?: boolean;
    concurrencyAllowed?: boolean;
    upsertDuplicate?: boolean;
  } = {},
) {
  const postMessage = vi.fn<SlackClient['postMessage']>().mockResolvedValue({ ts: '999.999' });
  const getThreadRoot =
    overrides.getThreadRoot ??
    vi.fn<SlackClient['getThreadRoot']>().mockResolvedValue({ text: '', blocks: BLOCKS });
  const slack: SlackClient = { postMessage, getThreadRoot };

  const upsertReport = vi
    .fn()
    .mockResolvedValue({ duplicate: overrides.upsertDuplicate ?? false, record: {} });
  const claimThread = vi.fn().mockResolvedValue(true);
  const threads: SlackThreadRegistry = { claimThread };

  const tryAcquire = vi.fn().mockResolvedValue(overrides.lockAcquirable ?? true);
  const release = vi.fn().mockResolvedValue(true);
  const tryReserve = vi.fn().mockResolvedValue(overrides.concurrencyAllowed ?? true);
  const concurrencyRelease = vi.fn().mockResolvedValue(undefined);
  const publish = vi.fn().mockResolvedValue(undefined);
  const createBatch = vi.fn().mockResolvedValue(undefined);

  const deps: Omit<HandleSlackEventInput, 'headers' | 'rawBody' | 'signingSecret' | 'nowMs'> = {
    slack,
    accountMap: ACCOUNT_MAP,
    thresholds: THRESHOLDS,
    reports: { upsertReport },
    threads,
    locks: { tryAcquire, release },
    concurrency: {
      limiter: { tryReserve, release: concurrencyRelease },
      maxGlobalInvestigations: 5,
      maxPerReportInvestigations: 3,
    },
    queue: { publish },
    batches: { createBatch },
    lockTtlMs: 300_000,
    batchTtlMs: 900_000,
  };

  return {
    deps,
    postMessage,
    getThreadRoot,
    upsertReport,
    claimThread,
    tryAcquire,
    release,
    tryReserve,
    publish,
    createBatch,
  };
}

describe('handleSlackEvent', () => {
  it('rejects a request with an invalid signature', async () => {
    const rawBody = appMentionBody();
    const { deps, postMessage } = fakeDeps();
    const result = await handleSlackEvent({
      headers: {
        'x-slack-signature': 'v0=bad',
        'x-slack-request-timestamp': String(Math.floor(NOW_MS / 1000)),
      },
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });
    expect(result.statusCode).toBe(401);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('answers the url_verification challenge without checking the envelope shape', async () => {
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const { deps } = fakeDeps();
    const result = await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });
    expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ challenge: 'abc123' }) });
  });

  it('rejects a payload that is not a recognized app_mention envelope', async () => {
    const rawBody = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const { deps } = fakeDeps();
    const result = await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });
    expect(result.statusCode).toBe(400);
  });

  it('replies in-thread when the tagged message has no readable root', async () => {
    const rawBody = appMentionBody();
    const { deps, postMessage } = fakeDeps({ getThreadRoot: vi.fn().mockResolvedValue(undefined) });
    const result = await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });
    expect(result).toEqual({ statusCode: 200, body: 'ok' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Couldn't read the cost report message in this thread." }),
    );
  });

  it('replies with the parse failure reason when the thread root is not a cost report', async () => {
    const rawBody = appMentionBody();
    const { deps, postMessage } = fakeDeps({
      getThreadRoot: vi.fn().mockResolvedValue({ text: 'not a cost report' }),
    });
    const result = await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });
    expect(result).toEqual({ statusCode: 200, body: 'ok' });
    expect(postMessage.mock.calls[0]?.[0]?.text).toContain("Couldn't parse a cost report");
  });

  it('upserts the report, claims the thread, and enqueues notable lines that need investigating', async () => {
    const rawBody = appMentionBody({ thread_ts: '1758700700.000000' });
    const { deps, postMessage, upsertReport, claimThread, publish, createBatch } = fakeDeps();
    const result = await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });

    expect(result).toEqual({ statusCode: 200, body: 'ok' });
    expect(upsertReport).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventId: '1758700800.000100',
        slackChannel: 'C123',
        slackThreadTs: '1758700700.000000',
      }),
    );
    expect(claimThread).toHaveBeenCalledWith('2026-09-24', '1758700700.000000');
    // Both Total AWS and PACO - Production cross the 10% threshold.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(createBatch).toHaveBeenCalledWith(
      expect.objectContaining({ reportDate: '2026-09-24', expectedCount: 2 }),
    );

    const call = postMessage.mock.calls[0]?.[0];
    expect(call?.channel).toBe('C123');
    expect(call?.thread_ts).toBe('1758700700.000000');
    expect(call?.text).toContain('Total AWS');
    expect(call?.text).toContain('Investigating');
    expect(call?.text).toContain('One consolidated update will follow in this thread.');
  });

  it('enqueues a fresh investigation even when this line was investigated before', async () => {
    const rawBody = appMentionBody();
    const { deps, postMessage, publish } = fakeDeps();
    await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });

    // No cache/rate-limit short-circuit: every notable line always enqueues.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0]?.[0]?.text).toContain('Investigating');
  });

  it('does not repost the ack when upsertReport reports a Slack event redelivery', async () => {
    const rawBody = appMentionBody();
    const { deps, postMessage, claimThread, publish } = fakeDeps({ upsertDuplicate: true });
    const result = await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });

    expect(result).toEqual({ statusCode: 200, body: 'ok' });
    expect(postMessage).not.toHaveBeenCalled();
    // Coordination still runs (it's safe to repeat — lock reacquire-by-
    // same-owner and execution-name collisions are both no-ops); only the
    // redundant ack post is suppressed.
    expect(claimThread).toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it('excludes a lock-contended line from expectedCount and still creates a batch for the rest', async () => {
    const rawBody = appMentionBody();
    let calls = 0;
    const { deps, publish, createBatch } = fakeDeps({
      lockAcquirable: true,
    });
    // First notable line (Total AWS) fails to acquire the lock; the second
    // (PACO - Production) succeeds — only the latter should count.
    (deps.locks.tryAcquire as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1;
      return Promise.resolve(calls > 1);
    });
    await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(createBatch).toHaveBeenCalledWith(expect.objectContaining({ expectedCount: 1 }));
  });

  it('creates no batch and publishes nothing when every notable line is throttled', async () => {
    const rawBody = appMentionBody();
    const { deps, publish, createBatch, postMessage } = fakeDeps({ lockAcquirable: false });
    await handleSlackEvent({
      headers: signedHeaders(rawBody),
      rawBody,
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
      ...deps,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(createBatch).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0]?.[0]?.text).toContain(
      'already being investigated or at capacity',
    );
  });
});

describe('verifySlackSignature', () => {
  it('rejects a timestamp outside the replay window', () => {
    const rawBody = '{}';
    const staleTimestamp = String(Math.floor(NOW_MS / 1000) - 3600);
    const signature = `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${staleTimestamp}:${rawBody}`).digest('hex')}`;
    expect(
      verifySlackSignature({
        signingSecret: SIGNING_SECRET,
        timestampHeader: staleTimestamp,
        signatureHeader: signature,
        rawBody,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});

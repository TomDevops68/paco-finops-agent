import { describe, expect, it, vi } from 'vitest';
import { SlackWebApiClient } from './client.js';

function formBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

describe('SlackWebApiClient', () => {
  it('posts a message with the bot token and returns its timestamp', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, ts: '1234.5678' }) });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    const result = await client.postMessage({ channel: '#cost-alerts', text: 'hello' });
    expect(result).toEqual({ ts: '1234.5678' });
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toContain('chat.postMessage');
    expect(init.headers.Authorization).toBe('Bearer xoxb-secret');
    expect(init.headers['Content-Type']).toContain('application/x-www-form-urlencoded');
    expect(formBody(init.body)).toEqual({ channel: '#cost-alerts', text: 'hello' });
  });

  it('updates an existing message by timestamp', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    await client.updateMessage({ channel: '#cost-alerts', ts: '1234.5678', text: 'updated' });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain('chat.update');
  });

  it('throws a safe error without leaking the bot token when the Slack API rejects the call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    await expect(client.postMessage({ channel: '#missing', text: 'hello' })).rejects.toThrow(
      'channel_not_found',
    );
  });

  it('posts a reply into an existing thread when thread_ts is given', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, ts: '1234.9999' }) });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    await client.postMessage({
      channel: '#cost-alerts',
      text: 'step update',
      thread_ts: '1234.5678',
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(formBody(init.body)).toEqual({
      channel: '#cost-alerts',
      text: 'step update',
      thread_ts: '1234.5678',
    });
  });

  it('fetches a thread root message with its blocks', async () => {
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Cloud Spending Analysis - 2026-09-24' },
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, messages: [{ text: '', ts: '1234.5678', blocks }] }),
    });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    const result = await client.getThreadRoot({ channel: '#cost-alerts', threadTs: '1234.5678' });
    expect(result).toEqual({ text: '', blocks });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('conversations.replies');
    expect(formBody(init.body)).toEqual({
      channel: '#cost-alerts',
      ts: '1234.5678',
      limit: '1',
      inclusive: 'true',
    });
  });

  it('fetches a plain-text-only thread root (no blocks)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ ok: true, messages: [{ text: 'the alert text', ts: '1234.5678' }] }),
    });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    const result = await client.getThreadRoot({ channel: '#cost-alerts', threadTs: '1234.5678' });
    expect(result).toEqual({ text: 'the alert text' });
  });

  it('returns undefined when the thread has no messages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true, messages: [] }) });
    const client = new SlackWebApiClient({ botToken: 'xoxb-secret', fetchImpl });
    const result = await client.getThreadRoot({ channel: '#cost-alerts', threadTs: '1234.5678' });
    expect(result).toBeUndefined();
  });
});

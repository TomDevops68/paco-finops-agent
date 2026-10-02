export type SlackHttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface SlackWebApiClientOptions {
  botToken: string;
  fetchImpl?: SlackHttpFetch;
  baseUrl?: string;
}

export interface SlackBlockText {
  type: string;
  text: string;
}

export interface SlackBlock {
  type: string;
  text?: SlackBlockText;
}

interface SlackApiResponse {
  ok: boolean;
  ts?: string;
  error?: string;
  messages?: { text?: string; ts?: string; blocks?: SlackBlock[] }[];
}

/**
 * Bounded Slack Web API client using `chat.postMessage`/`chat.update`/
 * `conversations.replies` only — ported from paco-troubleshoot-agent's
 * `packages/slack-connector`, which is domain-generic (no incident-specific
 * coupling). The bot token is injected out of band (Secrets Manager) and
 * never logged or returned.
 */
export class SlackWebApiClient {
  private readonly fetchImpl: SlackHttpFetch;
  private readonly baseUrl: string;

  public constructor(private readonly options: SlackWebApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as SlackHttpFetch);
    this.baseUrl = options.baseUrl ?? 'https://slack.com/api';
  }

  public async postMessage(input: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<{ ts: string }> {
    const response = await this.call('chat.postMessage', input);
    if (!response.ts) throw new Error('SLACK_POST_MESSAGE_MISSING_TS');
    return { ts: response.ts };
  }

  public async updateMessage(input: { channel: string; ts: string; text: string }): Promise<void> {
    await this.call('chat.update', input);
  }

  /**
   * Fetches the root (first) message of a thread — used by the app-mention
   * trigger to read the cost-report message the human tagged the agent
   * under. Unlike paco-troubleshoot-agent's chatbot alerts (plain text),
   * `paco-daily-cost-report` posts a Block-Kit-only message via a raw
   * incoming webhook: Slack's server-generated `text` fallback for a
   * blocks-only message is lossy/unreliable, so `blocks` is returned
   * alongside `text` and is the parser's primary input.
   */
  public async getThreadRoot(input: {
    channel: string;
    threadTs: string;
  }): Promise<{ text: string; blocks?: SlackBlock[] } | undefined> {
    const response = await this.call('conversations.replies', {
      channel: input.channel,
      ts: input.threadTs,
      limit: 1,
      inclusive: true,
    });
    const message = response.messages?.[0];
    if (!message?.text && !message?.blocks) return undefined;
    return { text: message.text ?? '', ...(message.blocks ? { blocks: message.blocks } : {}) };
  }

  /**
   * Form-encoded, not JSON: some Slack Web API methods (conversations.replies
   * among them) silently reject a JSON body with "missing required field" for
   * every field, even though chat.postMessage/chat.update accept JSON fine —
   * caught live in paco-troubleshoot-agent (2026-09-24). Form encoding works
   * universally across the whole Web API, so every method call uses it.
   */
  private async call(
    method: string,
    body: Record<string, string | number | boolean | undefined>,
  ): Promise<SlackApiResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: params.toString(),
    });
    const parsed = (await response.json()) as SlackApiResponse;
    if (!response.ok || !parsed.ok) {
      throw new Error(`SLACK_API_ERROR: ${parsed.error ?? String(response.ok)}`);
    }
    return parsed;
  }
}

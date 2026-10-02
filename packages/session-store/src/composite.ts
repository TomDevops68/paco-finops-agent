import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { foldSessionSummary } from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
  SessionSummaryEntry,
} from '@anthropic-ai/claude-agent-sdk';

export interface SessionMetadataCommandClient {
  send(
    command: unknown,
  ): Promise<{ Item?: Record<string, unknown>; Items?: Record<string, unknown>[] }>;
}

export interface SessionMetadataStoreOptions {
  tableName: string;
  projectKeyIndexName: string;
  ttlSeconds: number;
}

function metadataKey(key: SessionKey): string {
  return key.subpath
    ? `${key.projectKey}#${key.sessionId}#${key.subpath}`
    : `${key.projectKey}#${key.sessionId}`;
}

/**
 * Ported verbatim from paco-troubleshoot-agent's `DynamoDbSessionMetadataStore`
 * — layers DynamoDB session metadata (folded summaries, TTL) on top of an
 * inner transcript `SessionStore` (S3). Fully generic; no domain coupling.
 */
export class DynamoDbSessionMetadataStore implements SessionStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly inner: SessionStore,
    private readonly client: SessionMetadataCommandClient,
    private readonly options: SessionMetadataStoreOptions,
  ) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.inner.append(key, entries);
    if (key.subpath) return;
    const id = metadataKey(key);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const existing = await this.readSummary(key);
      const summary = foldSessionSummary(existing, key, entries, { mtime: Date.now() });
      await this.client.send(
        new PutCommand({
          TableName: this.options.tableName,
          Item: {
            sessionKey: id,
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            summary,
            expiresAt: Math.floor(summary.mtime / 1_000) + this.options.ttlSeconds,
          },
        }),
      );
    });
    this.queues.set(id, next);
    await next;
    if (this.queues.get(id) === next) this.queues.delete(id);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.inner.load(key);
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    if (this.inner.listSessions) return this.inner.listSessions(projectKey);
    const summaries = await this.listSessionSummaries(projectKey);
    return summaries.map((summary) => ({ sessionId: summary.sessionId, mtime: summary.mtime }));
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.options.tableName,
        IndexName: this.options.projectKeyIndexName,
        KeyConditionExpression: 'projectKey = :projectKey',
        ExpressionAttributeValues: { ':projectKey': projectKey },
      }),
    );
    return (result.Items ?? []).map((item) => item.summary as SessionSummaryEntry);
  }

  async delete(key: SessionKey): Promise<void> {
    await this.inner.delete?.(key);
    await this.client.send(
      new DeleteCommand({
        TableName: this.options.tableName,
        Key: { sessionKey: metadataKey(key) },
      }),
    );
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return (await this.inner.listSubkeys?.(key)) ?? [];
  }

  private async readSummary(key: SessionKey): Promise<SessionSummaryEntry | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: { sessionKey: metadataKey(key) },
        ConsistentRead: true,
      }),
    );
    return (result.Item as { summary?: SessionSummaryEntry } | undefined)?.summary;
  }
}

/**
 * Cost-domain rename of paco-troubleshoot-agent's `IncidentSessionMapping`/
 * `DynamoDbIncidentSessionMapping`/`IncidentMappedSessionStore` — a session
 * belongs to exactly one `lineFingerprint` (this domain's equivalent of
 * `analysisKey`), so the harness can resume the exact session for a given
 * report line instead of reconstructing one.
 */
export interface CostSessionMapping {
  recordSession(lineFingerprint: string, key: SessionKey): Promise<void>;
  getSession(lineFingerprint: string): Promise<SessionKey | undefined>;
}

export class DynamoDbCostSessionMapping implements CostSessionMapping {
  constructor(
    private readonly client: SessionMetadataCommandClient,
    private readonly tableName: string,
  ) {}

  async recordSession(lineFingerprint: string, key: SessionKey): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { sessionKey: `LINE#${lineFingerprint}`, mappedSession: key },
      }),
    );
  }

  async getSession(lineFingerprint: string): Promise<SessionKey | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { sessionKey: `LINE#${lineFingerprint}` },
        ConsistentRead: true,
      }),
    );
    return (result.Item as { mappedSession?: SessionKey } | undefined)?.mappedSession;
  }
}

/** Records the SDK-assigned session ID as soon as its first durable append succeeds. */
export class CostMappedSessionStore implements SessionStore {
  constructor(
    private readonly inner: SessionStore,
    private readonly mapping: CostSessionMapping,
    private readonly lineFingerprint: string,
  ) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.inner.append(key, entries);
    if (!key.subpath) await this.mapping.recordSession(this.lineFingerprint, key);
  }

  load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return this.inner.load(key);
  }

  listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    return this.inner.listSessions?.(projectKey) ?? Promise.resolve([]);
  }

  listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    return this.inner.listSessionSummaries?.(projectKey) ?? Promise.resolve([]);
  }

  async delete(key: SessionKey): Promise<void> {
    await this.inner.delete?.(key);
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return (await this.inner.listSubkeys?.(key)) ?? [];
  }
}

import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

interface StoredSession {
  entries: SessionStoreEntry[];
  mtime: number;
}

function storageId(key: SessionKey): string {
  return key.subpath
    ? `${key.projectKey}\0${key.sessionId}\0${key.subpath}`
    : `${key.projectKey}\0${key.sessionId}`;
}

/**
 * Ported verbatim from paco-troubleshoot-agent's
 * `InMemoryExternalSessionStore` — fully generic Agent SDK `SessionStore`
 * conformance fixture, no incident/cost-specific coupling. Production wiring
 * replaces this with S3/DynamoDB (see `s3.ts`/`composite.ts`).
 */
export class InMemoryExternalSessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly queues = new Map<string, Promise<void>>();

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const id = storageId(key);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(() => {
      const session = this.sessions.get(id) ?? { entries: [], mtime: Date.now() };
      const uuids = new Set(session.entries.flatMap((entry) => (entry.uuid ? [entry.uuid] : [])));
      for (const entry of entries) {
        if (entry.uuid && uuids.has(entry.uuid)) continue;
        session.entries.push(structuredClone(entry));
        if (entry.uuid) uuids.add(entry.uuid);
      }
      session.mtime = Date.now();
      this.sessions.set(id, session);
    });
    this.queues.set(id, next);
    await next;
    if (this.queues.get(id) === next) this.queues.delete(id);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    await Promise.resolve();
    const session = this.sessions.get(storageId(key));
    return session ? session.entries.map((entry) => structuredClone(entry)) : null;
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    await Promise.resolve();
    const prefix = `${projectKey}\0`;
    return [...this.sessions.entries()]
      .filter(([id]) => id.startsWith(prefix) && !id.slice(prefix.length).includes('\0'))
      .map(([id, session]) => ({ sessionId: id.slice(prefix.length), mtime: session.mtime }));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    await Promise.resolve();
    const prefix = `${key.projectKey}\0${key.sessionId}\0`;
    return [...this.sessions.keys()]
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length));
  }

  async delete(key: SessionKey): Promise<void> {
    await Promise.resolve();
    this.sessions.delete(storageId(key));
  }
}

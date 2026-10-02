import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

export interface S3SessionCommandClient {
  send(command: unknown): Promise<unknown>;
}

interface StoredSessionDocument {
  entries: SessionStoreEntry[];
  mtime: number;
}

interface LoadedDocument {
  document: StoredSessionDocument;
  etag?: string;
}

function sessionPrefix(projectKey: string, sessionId: string): string {
  return `sessions/${encodeURIComponent(projectKey)}/${encodeURIComponent(sessionId)}`;
}

function objectKey(key: SessionKey): string {
  const prefix = sessionPrefix(key.projectKey, key.sessionId);
  return key.subpath ? `${prefix}/${encodeURIComponent(key.subpath)}.json` : `${prefix}.json`;
}

/** Ported verbatim from paco-troubleshoot-agent's `S3ExternalSessionStore` — fully generic. */
export class S3ExternalSessionStore implements SessionStore {
  private readonly queues = new Map<string, Promise<void>>();

  public constructor(
    private readonly client: S3SessionCommandClient,
    private readonly bucket: string,
  ) {}

  public async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const id = objectKey(key);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await this.loadDocument(id);
        const current = loaded?.document ?? { entries: [], mtime: 0 };
        const uuids = new Set(current.entries.flatMap((entry) => (entry.uuid ? [entry.uuid] : [])));
        for (const entry of entries) {
          if (entry.uuid && uuids.has(entry.uuid)) continue;
          current.entries.push(structuredClone(entry));
          if (entry.uuid) uuids.add(entry.uuid);
        }
        current.mtime = Date.now();
        try {
          await this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: id,
              Body: JSON.stringify(current),
              ContentType: 'application/json',
              ServerSideEncryption: 'AES256',
              ...(loaded?.etag ? { IfMatch: loaded.etag } : {}),
            }),
          );
          return;
        } catch (error) {
          if (!isPreconditionFailure(error) || attempt === 2) throw error;
        }
      }
    });
    this.queues.set(id, next);
    await next;
    if (this.queues.get(id) === next) this.queues.delete(id);
  }

  public async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const loaded = await this.loadDocument(objectKey(key));
    return loaded ? loaded.document.entries.map((entry) => structuredClone(entry)) : null;
  }

  public async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    const prefix = `sessions/${encodeURIComponent(projectKey)}/`;
    const response = (await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    )) as {
      Contents?: { Key?: string }[];
    };
    const sessions: { sessionId: string; mtime: number }[] = [];
    for (const item of response.Contents ?? []) {
      if (!item.Key?.startsWith(prefix) || !item.Key.endsWith('.json')) continue;
      const remainder = item.Key.slice(prefix.length, -'.json'.length);
      if (remainder.includes('/')) continue;
      const loaded = await this.loadDocument(item.Key);
      if (loaded)
        sessions.push({ sessionId: decodeURIComponent(remainder), mtime: loaded.document.mtime });
    }
    return sessions;
  }

  public async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const prefix = `${sessionPrefix(key.projectKey, key.sessionId)}/`;
    const response = (await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    )) as {
      Contents?: { Key?: string }[];
    };
    const subkeys: string[] = [];
    for (const item of response.Contents ?? []) {
      if (!item.Key?.startsWith(prefix) || !item.Key.endsWith('.json')) continue;
      subkeys.push(decodeURIComponent(item.Key.slice(prefix.length, -'.json'.length)));
    }
    return subkeys;
  }

  public async delete(key: SessionKey): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey(key) }));
  }

  private async loadDocument(key: string): Promise<LoadedDocument | null> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        Body?: { transformToString?: () => Promise<string> };
        ETag?: string;
      };
      if (!response.Body?.transformToString) return null;
      return {
        document: JSON.parse(await response.Body.transformToString()) as StoredSessionDocument,
        ...(response.ETag ? { etag: response.ETag } : {}),
      };
    } catch (error) {
      if (error instanceof Error && /NoSuchKey|NotFound|404/.test(error.name + error.message))
        return null;
      throw error;
    }
  }
}

function isPreconditionFailure(error: unknown): boolean {
  return error instanceof Error && /PreconditionFailed|412/.test(error.name + error.message);
}

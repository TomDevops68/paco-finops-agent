import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface SecretsCommandClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Ported verbatim from paco-troubleshoot-agent's `CachedSecretReader` —
 * fetches an exact secret ARN once per Lambda/task execution environment and
 * caches it in memory. Callers must request the exact ARN they need — never
 * a broad `secretsmanager:GetSecretValue` grant.
 */
export class CachedSecretReader {
  private readonly cache = new Map<string, Promise<string>>();

  public constructor(private readonly client: SecretsCommandClient) {}

  public getSecretString(secretId: string): Promise<string> {
    const cached = this.cache.get(secretId);
    if (cached) return cached;
    const promise = this.fetch(secretId);
    this.cache.set(secretId, promise);
    return promise;
  }

  private async fetch(secretId: string): Promise<string> {
    const response = (await this.client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    )) as {
      SecretString?: string;
    };
    if (!response.SecretString) throw new Error(`SECRET_VALUE_MISSING: ${secretId}`);
    return response.SecretString;
  }
}

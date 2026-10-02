import type { CostSessionMapping } from '../../session-store/src/composite.js';

/**
 * A session belongs to exactly one `lineFingerprint`. Looks up the exact
 * prior session so a worker restart, retry, or deferred follow-up resumes it
 * instead of starting a fresh conversation. Ported from
 * paco-troubleshoot-agent's `resolveResumeSessionId`/`withResume`.
 */
export async function resolveResumeSessionId(
  lineFingerprint: string,
  mapping: CostSessionMapping,
): Promise<string | undefined> {
  const mapped = await mapping.getSession(lineFingerprint);
  return mapped?.sessionId;
}

export function withResume<T extends Record<string, unknown>>(
  options: T,
  resumeSessionId: string | undefined,
): T & { resume?: string } {
  return resumeSessionId ? { ...options, resume: resumeSessionId } : options;
}

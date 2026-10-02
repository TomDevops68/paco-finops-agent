import { createHash } from 'node:crypto';

/**
 * Stable per-investigation-attempt token, ported from paco-troubleshoot-agent's
 * `deriveInvestigationOwnerToken` (packages/core/src/execution-identity.ts).
 * Correlates the investigation lock, concurrency reservations, and the Step
 * Functions execution name across the Slack handler, the SQS message, and
 * the outer supervisor — and doubles as an idempotent Step Functions
 * execution name for a redelivered Slack Events API request (same
 * `sourceEventId` -> same token -> `StartExecution` on an already-`RUNNING`
 * name is a safe no-op).
 *
 * Including `sourceEventId` (the Slack event ID), not `lineFingerprint`
 * alone, matters for the same reason documented in the original: a later
 * `@mention` under the same thread reuses the same `lineFingerprint` but has
 * a different `sourceEventId`, and Step Functions enforces execution-name
 * uniqueness for 90 days regardless of whether the prior execution finished
 * — see that file's full incident writeup before changing this.
 */
export function deriveCostOwnerToken(lineFingerprint: string, sourceEventId: string): string {
  return `cost-${createHash('sha256').update(`${lineFingerprint}:${sourceEventId}`).digest('hex').slice(0, 32)}`;
}

import { createHash } from 'node:crypto';
import type { NormalizedCostReport } from '../../schemas/src/index.js';

/**
 * Length-prefixed join before hashing — avoids ambiguous concatenation
 * collisions (`"ab" + "c"` vs `"a" + "bc"`). Same idiom as
 * paco-troubleshoot-agent's `createBaseFingerprint`/`createAnalysisKey`.
 */
function sha256(parts: readonly string[]): string {
  const framed = parts
    .map((part) => `${String(Buffer.byteLength(part, 'utf8'))}:${part}`)
    .join('|');
  return createHash('sha256').update(framed).digest('hex');
}

/**
 * Identity for a whole report: one investigation per report date, however
 * many times the agent gets tagged under that thread. Deliberately doesn't
 * fold in dollar amounts — the report date alone is the dedup key, so a
 * second `@mention` under the same thread reuses the first analysis instead
 * of re-running Cost Explorer queries.
 */
export function costReportFingerprint(report: NormalizedCostReport): string {
  return sha256([report.reportDate]);
}

/**
 * Identity for one line within a report — used to key evidence/analysis
 * gathered for a specific account or service slice, so investigating one
 * notable line doesn't invalidate the cache for a sibling line in the same
 * report.
 */
export function costLineFingerprint(
  report: NormalizedCostReport,
  line: NormalizedCostReport['lines'][number],
): string {
  return sha256([report.reportDate, line.kind, line.label]);
}

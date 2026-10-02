import { classifySignificance } from '../../../packages/core/src/index.js';
import { selectRoutingPlaybook, type PlaybooksConfig } from '../../../packages/config/src/index.js';
import { costLineFingerprint } from '../../../packages/core/src/index.js';
import type { CostReportLine, NormalizedCostReport } from '../../../packages/schemas/src/index.js';

export interface CostReportReader {
  getReport(reportDate: string): Promise<{ report: NormalizedCostReport } | undefined>;
}

export interface ResolveContextInput {
  reportDate: string;
  lineFingerprint: string;
  ownerToken: string;
}

export type ResolveContextResult =
  | { outcome: 'REPORT_NOT_FOUND'; reportDate: string }
  | { outcome: 'LINE_NOT_FOUND'; reportDate: string }
  | { outcome: 'RESOLVED'; playbook: string; line: CostReportLine; reportDate: string };

/**
 * The dedup/cache check already happened in the Slack handler before this
 * line was ever enqueued (packages/aws-repositories/src/coordinate.ts) —
 * unlike paco-troubleshoot-agent's `resolve-context`, which has to branch on
 * CACHE_HIT/UNMAPPED_WORKLOAD because its ingest Lambda enqueues
 * unconditionally. This function's only job is to re-load the report (a
 * fresh read, not trusted from the SQS message body) and pick the
 * deterministic routing playbook for the ECS worker.
 */
export async function resolveContext(
  input: ResolveContextInput,
  reports: CostReportReader,
  playbooksConfig: PlaybooksConfig,
): Promise<ResolveContextResult> {
  const record = await reports.getReport(input.reportDate);
  if (!record) return { outcome: 'REPORT_NOT_FOUND', reportDate: input.reportDate };

  const line = record.report.lines.find(
    (candidate) => costLineFingerprint(record.report, candidate) === input.lineFingerprint,
  );
  if (!line) return { outcome: 'LINE_NOT_FOUND', reportDate: input.reportDate };

  const playbook = selectRoutingPlaybook(playbooksConfig, classifySignificance(line));
  return { outcome: 'RESOLVED', playbook, line, reportDate: input.reportDate };
}

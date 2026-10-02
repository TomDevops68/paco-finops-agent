import type { CostClassification, CostEvidenceRecord } from '../../schemas/src/index.js';
import type { BudgetUsage } from '../../core/src/index.js';
import {
  runAgentSession,
  type AgentMessageStreamFactory,
  type AgentSessionResult,
  type RunAgentSessionInput,
} from './runner.js';

export const WORKER_RESULT_SCHEMA_VERSION = '1.0';

export interface WorkerResult {
  schemaVersion: typeof WORKER_RESULT_SCHEMA_VERSION;
  executionId: string;
  reportDate: string;
  lineFingerprint: string;
  completedAt: string;
  sessionId: string | null;
  terminalSubtype: string;
  analysis: AgentSessionResult['analysis'];
  /** The exact evidence catalog used for this run, so the supervisor can independently re-validate. */
  evidenceCatalog: CostEvidenceRecord[];
  toolUses: string[];
  usage: BudgetUsage;
}

export interface WorkerResultStore {
  put(key: string, result: WorkerResult): Promise<void>;
  /** Returns `undefined` for anything short of a committed `READY` result. */
  get(key: string): Promise<WorkerResult | undefined>;
}

export interface RunWorkerInput extends Omit<RunAgentSessionInput, 'usage'> {
  executionId: string;
  reportDate: string;
  lineFingerprint: string;
  usage: BudgetUsage;
  resultStore: WorkerResultStore;
  resultKey?: string;
  streamFactory?: AgentMessageStreamFactory;
}

/** Ported from paco-troubleshoot-agent's `runWorker` — renamed incident->cost fields, otherwise unchanged. */
export async function runWorker(input: RunWorkerInput): Promise<WorkerResult> {
  const session = await runAgentSession(input, input.streamFactory);
  const result: WorkerResult = {
    schemaVersion: WORKER_RESULT_SCHEMA_VERSION,
    executionId: input.executionId,
    reportDate: input.reportDate,
    lineFingerprint: input.lineFingerprint,
    completedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    terminalSubtype: session.terminalSubtype,
    analysis: session.analysis,
    evidenceCatalog: [...input.evidenceCatalog],
    toolUses: [...session.toolUses],
    usage: { ...input.usage },
  };
  await input.resultStore.put(
    input.resultKey ?? `worker-results/${input.executionId}.json`,
    result,
  );
  return result;
}

export type { CostClassification, CostEvidenceRecord };

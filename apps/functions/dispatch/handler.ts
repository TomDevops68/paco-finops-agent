export interface DispatchMessage {
  reportDate: string;
  lineFingerprint: string;
  lineLabel: string;
  ownerToken: string;
  slackChannel: string;
  slackThreadTs: string;
  batchId: string;
  expectedCount: number;
  trendDirection: 'up' | 'down' | 'flat' | 'new';
}

export interface ExecutionStarter {
  startExecution(input: { name: string; input: string }): Promise<void>;
}

/**
 * `ownerToken` doubles as the Step Functions execution name (see
 * `packages/core/src/execution-identity.ts`'s comment) — a redelivered SQS
 * message derives the same token, so `StartExecution` on an
 * already-`RUNNING`/completed name is a safe, idempotent no-op rather than a
 * duplicate investigation.
 */
export async function dispatch(
  message: DispatchMessage,
  executions: ExecutionStarter,
): Promise<void> {
  await executions.startExecution({ name: message.ownerToken, input: JSON.stringify(message) });
}

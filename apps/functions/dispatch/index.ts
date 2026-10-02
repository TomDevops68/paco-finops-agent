import { SFNClient, StartExecutionCommand, ExecutionAlreadyExists } from '@aws-sdk/client-sfn';
import { dispatch, type DispatchMessage, type ExecutionStarter } from './handler.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

const sfn = new SFNClient({});
const stateMachineArn = mustEnv('STATE_MACHINE_ARN');

const executions: ExecutionStarter = {
  async startExecution(input) {
    try {
      await sfn.send(
        new StartExecutionCommand({ stateMachineArn, name: input.name, input: input.input }),
      );
    } catch (error) {
      // Redelivery-safe no-op — see dispatch()'s comment on why the
      // execution name is derived deterministically from the owner token.
      if (!(error instanceof ExecutionAlreadyExists)) throw error;
    }
  },
};

interface SqsRecord {
  body: string;
}

export async function handler(event: { Records: SqsRecord[] }): Promise<void> {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as DispatchMessage;
    await dispatch(message, executions);
  }
}

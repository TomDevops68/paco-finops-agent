import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { CostReportTrend } from '../../schemas/src/index.js';
import type { InvestigationQueuePublisher } from './coordinate.js';

export interface SqsCommandClient {
  send(command: unknown): Promise<unknown>;
}

export class SqsInvestigationPublisher implements InvestigationQueuePublisher {
  public constructor(
    private readonly client: SqsCommandClient,
    private readonly queueUrl: string,
  ) {}

  public async publish(message: {
    reportDate: string;
    lineFingerprint: string;
    lineLabel: string;
    ownerToken: string;
    slackChannel: string;
    slackThreadTs: string;
    batchId: string;
    expectedCount: number;
    trendDirection: CostReportTrend['direction'];
  }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ schemaVersion: '1.0', ...message }),
      }),
    );
  }
}

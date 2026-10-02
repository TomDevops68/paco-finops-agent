import { LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import type { ConnectorResult } from '../../agent-sdk-runtime/src/tool-server.js';
import type { AccountClientFactory } from './resource-describe.js';

export interface GetCloudTrailEventsInput {
  accountId: string;
  startDate: string;
  endDate: string;
  lookupAttributes: {
    attributeKey: 'EventName' | 'ResourceName' | 'Username';
    attributeValue: string;
  }[];
}

/**
 * The one signal in the rich root-cause report that generic CloudWatch
 * metrics can't cover: "who changed what, when" (e.g. an Aurora
 * minimum-reader-count change made by a specific IAM principal at a specific
 * time). Read-only: `LookupEvents` only ever returns management-event
 * history, never mutates anything.
 */
export class CloudTrailConnector {
  public constructor(private readonly clientFactory: AccountClientFactory) {}

  public async lookupEvents(input: GetCloudTrailEventsInput): Promise<ConnectorResult> {
    const clients = await this.clientFactory(input.accountId);
    if (!clients.cloudtrail) throw new Error('CLOUDTRAIL_CONNECTOR_DISABLED');
    const events = [];
    for (const attribute of input.lookupAttributes) {
      const response = await clients.cloudtrail.send(
        new LookupEventsCommand({
          StartTime: new Date(input.startDate),
          EndTime: new Date(input.endDate),
          LookupAttributes: [
            { AttributeKey: attribute.attributeKey, AttributeValue: attribute.attributeValue },
          ],
        }),
      );
      events.push(...(response.Events ?? []));
    }
    return {
      type: 'cloudtrail_event',
      summary: `${String(events.length)} CloudTrail event(s) found between ${input.startDate} and ${input.endDate} for ${input.lookupAttributes.map((a) => `${a.attributeKey}=${a.attributeValue}`).join(', ')}.`,
      data: events,
    };
  }
}

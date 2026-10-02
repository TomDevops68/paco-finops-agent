import { describe, expect, it, vi } from 'vitest';
import { CloudTrailConnector } from './cloudtrail.js';
import type { AccountClients } from './resource-describe.js';
import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail';

function fakeCloudTrailClient(response: unknown): CloudTrailClient {
  return { send: vi.fn().mockResolvedValue(response) } as unknown as CloudTrailClient;
}

describe('CloudTrailConnector', () => {
  it('looks up events for each lookup attribute and merges the results', async () => {
    const cloudtrail = fakeCloudTrailClient({
      Events: [{ EventName: 'ModifyDBCluster', Username: 'michael@blinxsolutions.com' }],
    });
    const clients: AccountClients = { cloudtrail };
    const connector = new CloudTrailConnector(() => Promise.resolve(clients));
    const result = await connector.lookupEvents({
      accountId: '680099409919',
      startDate: '2026-09-28T00:00:00Z',
      endDate: '2026-09-29T00:00:00Z',
      lookupAttributes: [{ attributeKey: 'ResourceName', attributeValue: 'nhs-prod' }],
    });
    expect(result.type).toBe('cloudtrail_event');
    expect(result.summary).toContain('1 CloudTrail event(s)');
    expect(result.data).toEqual([
      { EventName: 'ModifyDBCluster', Username: 'michael@blinxsolutions.com' },
    ]);
  });

  it('throws a safe error code when cloudtrail was never provisioned for this account', async () => {
    const connector = new CloudTrailConnector(() => Promise.resolve({}));
    await expect(
      connector.lookupEvents({
        accountId: '680099409919',
        startDate: '2026-09-28T00:00:00Z',
        endDate: '2026-09-29T00:00:00Z',
        lookupAttributes: [{ attributeKey: 'EventName', attributeValue: 'ModifyDBCluster' }],
      }),
    ).rejects.toThrow('CLOUDTRAIL_CONNECTOR_DISABLED');
  });
});

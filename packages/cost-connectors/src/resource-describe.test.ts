import { describe, expect, it, vi } from 'vitest';
import { ResourceDescribeConnector, type AccountClients } from './resource-describe.js';
import type { ECSClient } from '@aws-sdk/client-ecs';
import type { RDSClient } from '@aws-sdk/client-rds';

function fakeEcsClient(response: unknown): ECSClient {
  return { send: vi.fn().mockResolvedValue(response) } as unknown as ECSClient;
}

function fakeRdsClient(response: unknown): RDSClient {
  return { send: vi.fn().mockResolvedValue(response) } as unknown as RDSClient;
}

describe('ResourceDescribeConnector', () => {
  it('describes ECS services grouped by cluster from a "cluster|service" resource ID', async () => {
    const ecs = fakeEcsClient({ services: [{ serviceName: 'paco-talk-prod', desiredCount: 2 }] });
    const clients: AccountClients = { ecs };
    const connector = new ResourceDescribeConnector(() => Promise.resolve(clients));
    const result = await connector.describeResources({
      accountId: '510825518696',
      resourceType: 'ecs_service',
      resourceIds: ['paco-talk-prod-ecs-cluster|paco-talk-prod'],
    });
    expect(result.type).toBe('resource');
    expect(result.summary).toContain('paco-talk-prod (desired=2)');
  });

  it('rejects a malformed ECS resource ID without a cluster|service separator', async () => {
    const connector = new ResourceDescribeConnector(() =>
      Promise.resolve({ ecs: fakeEcsClient({}) }),
    );
    await expect(
      connector.describeResources({
        accountId: '510825518696',
        resourceType: 'ecs_service',
        resourceIds: ['bad-id'],
      }),
    ).rejects.toThrow('INVALID_ECS_RESOURCE_ID');
  });

  it('throws a safe error code when the requested client was never provisioned for this account', async () => {
    const connector = new ResourceDescribeConnector(() => Promise.resolve({}));
    await expect(
      connector.describeResources({
        accountId: '680099409919',
        resourceType: 'rds_instance',
        resourceIds: ['nhs-prod'],
      }),
    ).rejects.toThrow('RDS_CONNECTOR_DISABLED');
  });

  it('describes RDS instances by identifier', async () => {
    const rds = fakeRdsClient({
      DBInstances: [{ DBInstanceIdentifier: 'nhs-prod', DBInstanceClass: 'db.r5.8xlarge' }],
    });
    const connector = new ResourceDescribeConnector(() => Promise.resolve({ rds }));
    const result = await connector.describeResources({
      accountId: '510825518696',
      resourceType: 'rds_instance',
      resourceIds: ['nhs-prod'],
    });
    expect(result.summary).toContain('nhs-prod (db.r5.8xlarge)');
  });
});

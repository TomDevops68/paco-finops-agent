import { describe, expect, it, vi } from 'vitest';
import { CloudWatchConnector } from './cloudwatch.js';
import type { AccountClients } from './resource-describe.js';
import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';

function fakeCloudWatchClient(response: unknown): CloudWatchClient {
  return { send: vi.fn().mockResolvedValue(response) } as unknown as CloudWatchClient;
}

describe('CloudWatchConnector', () => {
  it('lists metrics in a namespace', async () => {
    const cloudwatch = fakeCloudWatchClient({
      Metrics: [{ Namespace: 'AWS/Lambda', MetricName: 'Invocations' }],
    });
    const clients: AccountClients = { cloudwatch };
    const connector = new CloudWatchConnector(() => Promise.resolve(clients));
    const result = await connector.listMetrics({
      accountId: '510825518696',
      namespace: 'AWS/Lambda',
    });
    expect(result.type).toBe('cloudwatch_metric');
    expect(result.summary).toContain('1 metric(s) found in namespace AWS/Lambda');
  });

  it('throws a safe error code when cloudwatch was never provisioned for this account', async () => {
    const connector = new CloudWatchConnector(() => Promise.resolve({}));
    await expect(
      connector.listMetrics({ accountId: '680099409919', namespace: 'AWS/Lambda' }),
    ).rejects.toThrow('CLOUDWATCH_CONNECTOR_DISABLED');
  });

  it('returns datapoints for a metric query', async () => {
    const cloudwatch = fakeCloudWatchClient({
      MetricDataResults: [{ Timestamps: [new Date('2026-09-28T00:00:00Z')], Values: [2190000] }],
    });
    const clients: AccountClients = { cloudwatch };
    const connector = new CloudWatchConnector(() => Promise.resolve(clients));
    const result = await connector.getMetricData({
      accountId: '510825518696',
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensions: [{ name: 'ApiName', value: 'supergrid' }],
      startDate: '2026-09-28T00:00:00Z',
      endDate: '2026-09-29T00:00:00Z',
      period: 3600,
      statistic: 'Sum',
    });
    expect(result.type).toBe('cloudwatch_metric');
    expect(result.summary).toContain('AWS/ApiGateway/Count');
    expect(result.summary).toContain('1 datapoint(s)');
    expect((result.data as { values: number[] }).values).toEqual([2190000]);
  });
});

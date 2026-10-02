import { describe, expect, it, vi } from 'vitest';
import { CostExplorerConnector } from './cost-explorer.js';
import type { CostExplorerClient } from '@aws-sdk/client-cost-explorer';

function fakeClient(response: unknown) {
  const send = vi.fn().mockResolvedValue(response);
  return { client: { send } as unknown as CostExplorerClient, send };
}

describe('CostExplorerConnector', () => {
  it('summarizes total cost across returned periods for get_cost_and_usage', async () => {
    const { client } = fakeClient({
      ResultsByTime: [
        { Total: { UnblendedCost: { Amount: '100.50' } } },
        { Total: { UnblendedCost: { Amount: '50.25' } } },
      ],
    });
    const connector = new CostExplorerConnector(client);
    const result = await connector.getCostAndUsage({
      startDate: '2026-09-23',
      endDate: '2026-09-25',
      groupBy: ['SERVICE'],
    });
    expect(result.type).toBe('cost_explorer');
    expect(result.summary).toContain('$150.75 total');
    expect(result.summary).toContain('2 period(s)');
  });

  it('scopes get_cost_and_usage to a linked account when accountId is given', async () => {
    const { client, send } = fakeClient({ ResultsByTime: [] });
    const connector = new CostExplorerConnector(client);
    await connector.getCostAndUsage({
      startDate: '2026-09-23',
      endDate: '2026-09-25',
      accountId: '510825518696',
    });
    const calls = send.mock.calls as unknown as [{ input: { Filter?: unknown } }][];
    expect(calls[0]?.[0]?.input.Filter).toEqual({
      Dimensions: { Key: 'LINKED_ACCOUNT', Values: ['510825518696'] },
    });
  });

  it('reports the anomaly count for get_cost_anomalies', async () => {
    const { client } = fakeClient({ Anomalies: [{ AnomalyId: 'a1' }, { AnomalyId: 'a2' }] });
    const connector = new CostExplorerConnector(client);
    const result = await connector.getCostAnomalies({
      startDate: '2026-09-20',
      endDate: '2026-09-24',
    });
    expect(result.type).toBe('anomaly');
    expect(result.summary).toContain('2 cost anomaly/anomalies');
  });

  it('reads nested Utilization.UtilizationPercentage for Savings Plans', async () => {
    const { client } = fakeClient({ Total: { Utilization: { UtilizationPercentage: '87.3' } } });
    const connector = new CostExplorerConnector(client);
    const result = await connector.getSavingsPlansUtilization({
      startDate: '2026-09-20',
      endDate: '2026-09-24',
    });
    expect(result.summary).toContain('87.3%');
  });

  it('reads flat UtilizationPercentage for Reserved Instances', async () => {
    const { client } = fakeClient({ Total: { UtilizationPercentage: '62.0' } });
    const connector = new CostExplorerConnector(client);
    const result = await connector.getReservationUtilization({
      startDate: '2026-09-20',
      endDate: '2026-09-24',
    });
    expect(result.summary).toContain('62.0%');
  });

  it('counts rightsizing recommendations', async () => {
    const { client } = fakeClient({ RightsizingRecommendations: [{}] });
    const connector = new CostExplorerConnector(client);
    const result = await connector.getRightsizingRecommendations({ service: 'AmazonEC2' });
    expect(result.summary).toContain('1 rightsizing recommendation(s)');
  });
});

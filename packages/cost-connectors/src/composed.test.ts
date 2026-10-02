import { describe, expect, it, vi } from 'vitest';
import { buildComposedCostConnector } from './composed.js';
import type { NormalizedCostReport } from '../../schemas/src/index.js';
import type { CostExplorerConnector } from './cost-explorer.js';
import type { ResourceDescribeConnector } from './resource-describe.js';
import type { PriorReportsConnector } from './prior-reports.js';
import type { CloudWatchConnector } from './cloudwatch.js';
import type { CloudTrailConnector } from './cloudtrail.js';

const report: NormalizedCostReport = {
  reportDate: '2026-09-24',
  lines: [
    {
      label: 'Total AWS',
      kind: 'total',
      yesterdayUsd: 1,
      trend: { direction: 'flat', percent: 0 },
      currentUsd: 1,
    },
  ],
};

function baseDependencies() {
  return {
    report,
    costExplorer: {} as CostExplorerConnector,
    resources: {} as ResourceDescribeConnector,
    priorReports: {} as PriorReportsConnector,
    cloudwatch: {} as CloudWatchConnector,
    cloudtrail: {} as CloudTrailConnector,
  };
}

describe('buildComposedCostConnector', () => {
  it('returns the pre-loaded report directly for get_report, without calling any AWS client', async () => {
    const getCostAndUsage = vi.fn();
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      costExplorer: { getCostAndUsage } as unknown as CostExplorerConnector,
    });
    const result = await connector.execute('get_report', { reportDate: '2026-09-24' });
    expect(result.data).toEqual(report);
    expect(getCostAndUsage).not.toHaveBeenCalled();
  });

  it('dispatches get_cost_and_usage to the Cost Explorer connector', async () => {
    const getCostAndUsage = vi
      .fn()
      .mockResolvedValue({ type: 'cost_explorer', summary: 'ok', data: {} });
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      costExplorer: { getCostAndUsage } as unknown as CostExplorerConnector,
    });
    const result = await connector.execute('get_cost_and_usage', {
      reportDate: '2026-09-24',
      startDate: 'a',
      endDate: 'b',
    });
    expect(result.summary).toBe('ok');
    expect(getCostAndUsage).toHaveBeenCalledWith({
      reportDate: '2026-09-24',
      startDate: 'a',
      endDate: 'b',
    });
  });

  it('dispatches describe_resources to the resource connector', async () => {
    const describeResources = vi
      .fn()
      .mockResolvedValue({ type: 'resource', summary: 'ok', data: {} });
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      resources: { describeResources } as unknown as ResourceDescribeConnector,
    });
    await connector.execute('describe_resources', {
      reportDate: '2026-09-24',
      accountId: '510825518696',
      resourceType: 'ecs_service',
      resourceIds: ['a|b'],
    });
    expect(describeResources).toHaveBeenCalled();
  });

  it('dispatches get_prior_reports to the prior-reports connector', async () => {
    const getPriorReports = vi
      .fn()
      .mockResolvedValue({ type: 'historical', summary: 'ok', data: [] });
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      priorReports: { getPriorReports } as unknown as PriorReportsConnector,
    });
    await connector.execute('get_prior_reports', { reportDate: '2026-09-24', limit: 3 });
    expect(getPriorReports).toHaveBeenCalled();
  });

  it('dispatches list_cloudwatch_metrics to the CloudWatch connector', async () => {
    const listMetrics = vi
      .fn()
      .mockResolvedValue({ type: 'cloudwatch_metric', summary: 'ok', data: [] });
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      cloudwatch: { listMetrics } as unknown as CloudWatchConnector,
    });
    await connector.execute('list_cloudwatch_metrics', {
      reportDate: '2026-09-24',
      accountId: '510825518696',
      namespace: 'AWS/Lambda',
    });
    expect(listMetrics).toHaveBeenCalled();
  });

  it('dispatches get_cloudwatch_metric to the CloudWatch connector', async () => {
    const getMetricData = vi
      .fn()
      .mockResolvedValue({ type: 'cloudwatch_metric', summary: 'ok', data: {} });
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      cloudwatch: { getMetricData } as unknown as CloudWatchConnector,
    });
    await connector.execute('get_cloudwatch_metric', {
      reportDate: '2026-09-24',
      accountId: '510825518696',
      namespace: 'AWS/Lambda',
      metricName: 'Invocations',
      dimensions: [],
      startDate: '2026-09-28',
      endDate: '2026-09-29',
      period: 3600,
      statistic: 'Sum',
    });
    expect(getMetricData).toHaveBeenCalled();
  });

  it('dispatches get_cloudtrail_events to the CloudTrail connector', async () => {
    const lookupEvents = vi
      .fn()
      .mockResolvedValue({ type: 'cloudtrail_event', summary: 'ok', data: [] });
    const connector = buildComposedCostConnector({
      ...baseDependencies(),
      cloudtrail: { lookupEvents } as unknown as CloudTrailConnector,
    });
    await connector.execute('get_cloudtrail_events', {
      reportDate: '2026-09-24',
      accountId: '510825518696',
      startDate: '2026-09-28',
      endDate: '2026-09-29',
      lookupAttributes: [
        { attributeKey: 'Username', attributeValue: 'michael@blinxsolutions.com' },
      ],
    });
    expect(lookupEvents).toHaveBeenCalled();
  });
});

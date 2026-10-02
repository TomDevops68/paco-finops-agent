import { describe, expect, it, vi } from 'vitest';
import {
  buildCostTools,
  buildEvidenceLink,
  executeEvidenceTool,
  type EvidenceLinkContext,
  type ToolServerDependencies,
} from './tool-server.js';

interface ToolLike {
  name: string;
  handler: (input: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: [{ type: 'text'; text: string }];
  }>;
}

function findTool(tools: unknown[], name: string): ToolLike {
  const found = (tools as ToolLike[]).find((t) => t.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

function baseAnalysisInput(): Record<string, unknown> {
  return {
    classification: 'GENERIC',
    status: 'INSUFFICIENT_EVIDENCE',
    summary: 'No driver found.',
    driver: null,
    confidence: 0.25,
    evidence: [],
    hypotheses: [],
    rejectedHypotheses: [],
    savingsRecommendations: [],
    limitations: [],
    serviceBreakdown: [],
  };
}

const context: EvidenceLinkContext = {
  region: 'eu-west-2',
  costReportsTableName: 'paco-cost-reports',
};

describe('buildEvidenceLink', () => {
  it('builds the exact Cost Explorer CLI call for get_cost_and_usage, with no url', () => {
    const link = buildEvidenceLink(
      'get_cost_and_usage',
      {
        reportDate: '2026-09-24',
        startDate: '2026-08-10',
        endDate: '2026-09-24',
        granularity: 'DAILY',
        groupBy: ['SERVICE'],
      },
      context,
    );
    expect(link.command).toBe(
      'aws ce get-cost-and-usage --time-period Start=2026-08-10,End=2026-09-24 --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE',
    );
    expect(link.detail).toBe('2026-08-10→2026-09-24, DAILY, grouped by SERVICE');
    expect(link.url).toBeUndefined();
  });

  it('includes an account filter flag when accountId is present', () => {
    const link = buildEvidenceLink(
      'get_cost_and_usage',
      {
        reportDate: '2026-09-24',
        startDate: '2026-08-10',
        endDate: '2026-09-24',
        granularity: 'DAILY',
        groupBy: ['SERVICE'],
        accountId: '123456789012',
      },
      context,
    );
    expect(link.command).toContain(
      `--filter '{"Dimensions":{"Key":"LINKED_ACCOUNT","Values":["123456789012"]}}'`,
    );
    expect(link.detail).toContain('account 123456789012');
  });

  it('links a single-instance describe_resources call to the Lambda console', () => {
    const link = buildEvidenceLink(
      'describe_resources',
      {
        reportDate: '2026-09-24',
        accountId: '123456789012',
        resourceType: 'lambda_function',
        resourceIds: ['nova-lite-worker'],
      },
      context,
    );
    expect(link.command).toBe(
      'aws lambda get-function-configuration --function-name nova-lite-worker --region eu-west-2',
    );
    expect(link.url).toBe(
      'https://eu-west-2.console.aws.amazon.com/lambda/home?region=eu-west-2#/functions/nova-lite-worker?tab=configure',
    );
  });

  it('omits the url for a multi-resource describe_resources call', () => {
    const link = buildEvidenceLink(
      'describe_resources',
      {
        reportDate: '2026-09-24',
        accountId: '123456789012',
        resourceType: 'lambda_function',
        resourceIds: ['nova-lite-worker', 'nova-lite-scheduler'],
      },
      context,
    );
    expect(link.command).toBe(
      'aws lambda get-function-configuration --function-name nova-lite-worker --region eu-west-2 && aws lambda get-function-configuration --function-name nova-lite-scheduler --region eu-west-2',
    );
    expect(link.url).toBeUndefined();
    expect(link.detail).toBe(
      '123456789012 — lambda_function — nova-lite-worker, nova-lite-scheduler',
    );
  });

  it('links a single ECS "cluster|service" resource id to the ECS console', () => {
    const link = buildEvidenceLink(
      'describe_resources',
      {
        reportDate: '2026-09-24',
        accountId: '123456789012',
        resourceType: 'ecs_service',
        resourceIds: ['paco-talk-prod-ecs-cluster|paco-talk-prod'],
      },
      context,
    );
    expect(link.command).toBe(
      'aws ecs describe-services --cluster paco-talk-prod-ecs-cluster --services paco-talk-prod --region eu-west-2',
    );
    expect(link.url).toBe(
      'https://eu-west-2.console.aws.amazon.com/ecs/v2/clusters/paco-talk-prod-ecs-cluster/services/paco-talk-prod/health?region=eu-west-2',
    );
  });

  it('builds a DynamoDB get-item call for get_report, with no url', () => {
    const link = buildEvidenceLink('get_report', { reportDate: '2026-09-24' }, context);
    expect(link.command).toBe(
      `aws dynamodb get-item --table-name paco-cost-reports --key '{"reportDate":{"S":"2026-09-24"}}' --region eu-west-2`,
    );
    expect(link.url).toBeUndefined();
  });

  it('builds a list-metrics CLI call for list_cloudwatch_metrics, with no url', () => {
    const link = buildEvidenceLink(
      'list_cloudwatch_metrics',
      { reportDate: '2026-09-24', accountId: '123456789012', namespace: 'AWS/Lambda' },
      context,
    );
    expect(link.command).toBe(
      'aws cloudwatch list-metrics --namespace AWS/Lambda --region eu-west-2',
    );
    expect(link.url).toBeUndefined();
  });

  it('builds a get-metric-data CLI call for get_cloudwatch_metric, with no url', () => {
    const link = buildEvidenceLink(
      'get_cloudwatch_metric',
      {
        reportDate: '2026-09-24',
        accountId: '123456789012',
        namespace: 'AWS/ApiGateway',
        metricName: 'Count',
        dimensions: [],
        startDate: '2026-09-28',
        endDate: '2026-09-29',
        period: 3600,
        statistic: 'Sum',
      },
      context,
    );
    expect(link.command).toBe(
      'aws cloudwatch get-metric-data --start-time 2026-09-28 --end-time 2026-09-29 --metric-data-queries \'[{"Id":"m1","MetricStat":{"Metric":{"Namespace":"AWS/ApiGateway","MetricName":"Count"},"Period":3600,"Stat":"Sum"}}]\' --region eu-west-2',
    );
    expect(link.url).toBeUndefined();
  });

  it('builds a lookup-events CLI call for get_cloudtrail_events, with no url', () => {
    const link = buildEvidenceLink(
      'get_cloudtrail_events',
      {
        reportDate: '2026-09-24',
        accountId: '123456789012',
        startDate: '2026-09-28',
        endDate: '2026-09-29',
        lookupAttributes: [
          { attributeKey: 'Username', attributeValue: 'michael@blinxsolutions.com' },
        ],
      },
      context,
    );
    expect(link.command).toBe(
      'aws cloudtrail lookup-events --start-time 2026-09-28 --end-time 2026-09-29 --region eu-west-2',
    );
    expect(link.url).toBeUndefined();
  });
});

describe('executeEvidenceTool', () => {
  const policy: ToolServerDependencies['policy'] = {
    reportDate: '2026-09-24',
    allowedAccountIds: ['123456789012'],
    earliestTime: '2026-08-01T00:00:00.000Z',
    latestTime: '2026-09-24T00:00:00.000Z',
    maxResultCharacters: 10_000,
  };

  it('persists a successful call with ok: true in its metadata', async () => {
    const persist = vi.fn().mockResolvedValue('EV-abc123');
    const dependencies: ToolServerDependencies = {
      connector: {
        execute: vi.fn().mockResolvedValue({ type: 'historical', summary: 'ok', data: {} }),
      },
      evidenceWriter: { persist },
      policy,
      context,
    };
    await executeEvidenceTool('get_report', { reportDate: '2026-09-24' }, dependencies);
    const persisted = persist.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(persisted.metadata.ok).toBe(true);
  });

  it('persists a failed call with ok: false and the safe error code, without throwing', async () => {
    const persist = vi.fn().mockResolvedValue('EV-ignored');
    const dependencies: ToolServerDependencies = {
      connector: { execute: vi.fn() },
      evidenceWriter: { persist },
      policy,
      context,
    };
    // reportDate mismatch trips `authorize()`'s REPORT_SCOPE_DENIED before the connector ever runs.
    const result = await executeEvidenceTool(
      'get_report',
      { reportDate: '2020-01-01' },
      dependencies,
    );
    expect(result.isError).toBe(true);
    const persisted = persist.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(persisted.metadata.ok).toBe(false);
    expect(persisted.metadata.error).toBe('REPORT_SCOPE_DENIED');
  });

  it('still returns the tool error even if persisting the failure record itself fails', async () => {
    const dependencies: ToolServerDependencies = {
      connector: { execute: vi.fn() },
      evidenceWriter: { persist: vi.fn().mockRejectedValue(new Error('S3_DOWN')) },
      policy,
      context,
    };
    const result = await executeEvidenceTool(
      'get_report',
      { reportDate: '2020-01-01' },
      dependencies,
    );
    if (!result.isError) throw new Error('expected an error result');
    expect(result.structuredContent.error.code).toBe('REPORT_SCOPE_DENIED');
  });
});

describe('buildCostTools — new evidence tools', () => {
  const policy: ToolServerDependencies['policy'] = {
    reportDate: '2026-09-24',
    allowedAccountIds: ['123456789012'],
    earliestTime: '2026-08-01T00:00:00.000Z',
    latestTime: '2026-09-24T00:00:00.000Z',
    maxResultCharacters: 10_000,
  };

  it('dispatches list_cloudwatch_metrics through to the connector', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ type: 'cloudwatch_metric', summary: 'ok', data: [] });
    const dependencies: ToolServerDependencies = {
      connector: { execute },
      evidenceWriter: { persist: vi.fn().mockResolvedValue('EV-1') },
      policy,
      context,
    };
    const tools = buildCostTools(dependencies);
    const result = await findTool(tools, 'list_cloudwatch_metrics').handler({
      reportDate: '2026-09-24',
      accountId: '123456789012',
      namespace: 'AWS/Lambda',
    });
    expect(result.isError ?? false).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      'list_cloudwatch_metrics',
      expect.objectContaining({ namespace: 'AWS/Lambda' }),
    );
  });

  it('dispatches get_cloudwatch_metric through to the connector', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ type: 'cloudwatch_metric', summary: 'ok', data: {} });
    const dependencies: ToolServerDependencies = {
      connector: { execute },
      evidenceWriter: { persist: vi.fn().mockResolvedValue('EV-1') },
      policy,
      context,
    };
    const tools = buildCostTools(dependencies);
    const result = await findTool(tools, 'get_cloudwatch_metric').handler({
      reportDate: '2026-09-24',
      accountId: '123456789012',
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensions: [],
      startDate: '2026-08-24',
      endDate: '2026-09-24',
      period: 3600,
      statistic: 'Sum',
    });
    expect(result.isError ?? false).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      'get_cloudwatch_metric',
      expect.objectContaining({ metricName: 'Count' }),
    );
  });

  it('dispatches get_cloudtrail_events through to the connector', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ type: 'cloudtrail_event', summary: 'ok', data: [] });
    const dependencies: ToolServerDependencies = {
      connector: { execute },
      evidenceWriter: { persist: vi.fn().mockResolvedValue('EV-1') },
      policy,
      context,
    };
    const tools = buildCostTools(dependencies);
    const result = await findTool(tools, 'get_cloudtrail_events').handler({
      reportDate: '2026-09-24',
      accountId: '123456789012',
      startDate: '2026-08-24',
      endDate: '2026-09-24',
      lookupAttributes: [{ attributeKey: 'EventName', attributeValue: 'ModifyDBCluster' }],
    });
    expect(result.isError ?? false).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      'get_cloudtrail_events',
      expect.objectContaining({
        lookupAttributes: [{ attributeKey: 'EventName', attributeValue: 'ModifyDBCluster' }],
      }),
    );
  });
});

describe('buildCostTools — guided retry on submit_final_analysis', () => {
  const policy: ToolServerDependencies['policy'] = {
    reportDate: '2026-09-24',
    allowedAccountIds: ['123456789012'],
    earliestTime: '2026-08-01T00:00:00.000Z',
    latestTime: '2026-09-24T00:00:00.000Z',
    maxResultCharacters: 10_000,
  };

  function dependenciesWith(
    execute: ToolServerDependencies['connector']['execute'],
  ): ToolServerDependencies {
    return {
      connector: { execute },
      evidenceWriter: { persist: vi.fn().mockResolvedValue('EV-1') },
      policy,
      context,
    };
  }

  // Regression for the 2026-09-29 live incident's follow-up: the crash was
  // fixed, but the model still submitted an empty serviceBreakdown because
  // it never called get_cost_and_usage with DAILY/SERVICE. This rejects that
  // submission once instead of silently accepting it.
  it('rejects an empty serviceBreakdown when no DAILY/SERVICE call has been attempted', async () => {
    const dependencies = dependenciesWith(
      vi.fn().mockResolvedValue({ type: 'cost_explorer', summary: 'ok', data: {} }),
    );
    const tools = buildCostTools(dependencies);
    const submit = findTool(tools, 'submit_final_analysis');

    const result = await submit.handler(baseAnalysisInput());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('granularity="DAILY"');
  });

  it('accepts an empty serviceBreakdown once a DAILY/SERVICE call has been attempted, even if it failed', async () => {
    const dependencies = dependenciesWith(vi.fn().mockRejectedValue(new Error('CONNECTOR_ERROR')));
    const tools = buildCostTools(dependencies);
    const getCostAndUsage = findTool(tools, 'get_cost_and_usage');
    const submit = findTool(tools, 'submit_final_analysis');

    await getCostAndUsage.handler({
      reportDate: '2026-09-24',
      startDate: '2026-09-22',
      endDate: '2026-09-24',
      granularity: 'DAILY',
      groupBy: ['SERVICE'],
    });
    const result = await submit.handler(baseAnalysisInput());

    expect(result.isError ?? false).toBe(false);
  });

  it('accepts a non-empty serviceBreakdown even without a prior DAILY/SERVICE call', async () => {
    const dependencies = dependenciesWith(
      vi.fn().mockResolvedValue({ type: 'cost_explorer', summary: 'ok', data: {} }),
    );
    const tools = buildCostTools(dependencies);
    const submit = findTool(tools, 'submit_final_analysis');

    const result = await submit.handler({
      ...baseAnalysisInput(),
      serviceBreakdown: [{ service: 'RDS', yesterdayUsd: 10, supportingEvidenceIds: ['EV-1'] }],
    });

    expect(result.isError ?? false).toBe(false);
  });

  it('does not count a MONTHLY get_cost_and_usage call as a qualifying attempt', async () => {
    const dependencies = dependenciesWith(
      vi.fn().mockResolvedValue({ type: 'cost_explorer', summary: 'ok', data: {} }),
    );
    const tools = buildCostTools(dependencies);
    const getCostAndUsage = findTool(tools, 'get_cost_and_usage');
    const submit = findTool(tools, 'submit_final_analysis');

    await getCostAndUsage.handler({
      reportDate: '2026-09-24',
      startDate: '2026-08-24',
      endDate: '2026-09-24',
      granularity: 'MONTHLY',
      groupBy: ['SERVICE'],
    });
    const result = await submit.handler(baseAnalysisInput());

    expect(result.isError).toBe(true);
  });
});

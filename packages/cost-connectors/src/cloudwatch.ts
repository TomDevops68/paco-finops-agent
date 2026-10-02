import { ListMetricsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { ConnectorResult } from '../../agent-sdk-runtime/src/tool-server.js';
import type { AccountClientFactory, AccountClients } from './resource-describe.js';

export interface ListCloudWatchMetricsInput {
  accountId: string;
  namespace: string;
  metricNamePrefix?: string;
}

export interface GetCloudWatchMetricInput {
  accountId: string;
  namespace: string;
  metricName: string;
  dimensions: { name: string; value: string }[];
  startDate: string;
  endDate: string;
  period: number;
  statistic: 'Sum' | 'Average' | 'Maximum' | 'Minimum' | 'SampleCount';
}

/**
 * Covers the generic-CloudWatch-metric signals from the rich root-cause
 * report (Lambda concurrency/invocations, API Gateway request counts, WAF
 * allowed/blocked counts, Redshift concurrency-scaling seconds, CloudWatch
 * Logs incoming-bytes) with one connector instead of five bespoke per-service
 * SDK integrations — every one of those is just a namespace/metric-name/
 * dimension combination on the same two CloudWatch APIs. `listMetrics` lets
 * the model discover the exact metric/dimension names to query before
 * calling `getMetricData`, so no static config (WAF ACL ARNs, Redshift
 * cluster IDs, log group names) needs to exist anywhere.
 */
export class CloudWatchConnector {
  public constructor(private readonly clientFactory: AccountClientFactory) {}

  public async listMetrics(input: ListCloudWatchMetricsInput): Promise<ConnectorResult> {
    const clients = await this.resolveClients(input.accountId);
    const response = await clients.cloudwatch.send(
      new ListMetricsCommand({
        Namespace: input.namespace,
        ...(input.metricNamePrefix ? { MetricName: input.metricNamePrefix } : {}),
      }),
    );
    const metrics = response.Metrics ?? [];
    return {
      type: 'cloudwatch_metric',
      summary: `${String(metrics.length)} metric(s) found in namespace ${input.namespace}${input.metricNamePrefix ? ` matching "${input.metricNamePrefix}"` : ''}.`,
      data: metrics,
    };
  }

  public async getMetricData(input: GetCloudWatchMetricInput): Promise<ConnectorResult> {
    const clients = await this.resolveClients(input.accountId);
    const response = await clients.cloudwatch.send(
      new GetMetricDataCommand({
        StartTime: new Date(input.startDate),
        EndTime: new Date(input.endDate),
        MetricDataQueries: [
          {
            Id: 'm1',
            MetricStat: {
              Metric: {
                Namespace: input.namespace,
                MetricName: input.metricName,
                Dimensions: input.dimensions.map((dimension) => ({
                  Name: dimension.name,
                  Value: dimension.value,
                })),
              },
              Period: input.period,
              Stat: input.statistic,
            },
          },
        ],
      }),
    );
    const result = response.MetricDataResults?.[0];
    const values = result?.Values ?? [];
    return {
      type: 'cloudwatch_metric',
      summary: `${input.namespace}/${input.metricName} (${input.statistic}, period=${String(input.period)}s): ${String(values.length)} datapoint(s) between ${input.startDate} and ${input.endDate}.`,
      data: { timestamps: result?.Timestamps ?? [], values },
    };
  }

  private async resolveClients(
    accountId: string,
  ): Promise<AccountClients & { cloudwatch: NonNullable<AccountClients['cloudwatch']> }> {
    const clients = await this.clientFactory(accountId);
    if (!clients.cloudwatch) throw new Error('CLOUDWATCH_CONNECTOR_DISABLED');
    return clients as AccountClients & { cloudwatch: NonNullable<AccountClients['cloudwatch']> };
  }
}

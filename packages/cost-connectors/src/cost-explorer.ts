import type { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import {
  GetAnomaliesCommand,
  GetCostAndUsageCommand,
  GetReservationUtilizationCommand,
  GetRightsizingRecommendationCommand,
  GetSavingsPlansUtilizationCommand,
} from '@aws-sdk/client-cost-explorer';
import type { ConnectorResult } from '../../agent-sdk-runtime/src/tool-server.js';

export interface CostExplorerInput {
  startDate: string;
  endDate: string;
  granularity?: 'DAILY' | 'MONTHLY';
  groupBy?: ('SERVICE' | 'USAGE_TYPE' | 'LINKED_ACCOUNT' | 'REGION')[];
  accountId?: string;
}

const DIMENSION_KEY: Record<string, 'SERVICE' | 'USAGE_TYPE' | 'LINKED_ACCOUNT' | 'REGION'> = {
  SERVICE: 'SERVICE',
  USAGE_TYPE: 'USAGE_TYPE',
  LINKED_ACCOUNT: 'LINKED_ACCOUNT',
  REGION: 'REGION',
};

/**
 * Thin wrapper around AWS Cost Explorer, mirroring the exact query shapes
 * `paco-daily-cost-report/lambda/index.py` already proves work in this
 * account (`GetCostAndUsage` with `LINKED_ACCOUNT` groupby run from the
 * management account, `GetCostForecast`-style date windows) — this doesn't
 * reinvent the CE query patterns, only adds the drill-down groupings the
 * daily summary Lambda doesn't need. Read-only: every method here maps to a
 * `ce:Get*` action, never a write.
 */
export class CostExplorerConnector {
  public constructor(private readonly client: CostExplorerClient) {}

  public async getCostAndUsage(input: CostExplorerInput): Promise<ConnectorResult> {
    const response = await this.client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: input.startDate, End: input.endDate },
        Granularity: input.granularity ?? 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: (input.groupBy ?? ['SERVICE']).map((key) => ({
          Type: 'DIMENSION',
          Key: DIMENSION_KEY[key],
        })),
        ...(input.accountId
          ? { Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [input.accountId] } } }
          : {}),
      }),
    );
    const periods = response.ResultsByTime ?? [];
    const totalUsd = periods.reduce(
      (sum, period) => sum + Number.parseFloat(period.Total?.UnblendedCost?.Amount ?? '0'),
      0,
    );
    return {
      type: 'cost_explorer',
      summary: `Cost and usage for ${input.startDate}..${input.endDate}, grouped by ${(input.groupBy ?? ['SERVICE']).join('/')}: $${totalUsd.toFixed(2)} total across ${String(periods.length)} period(s).`,
      data: periods,
    };
  }

  public async getCostAnomalies(input: {
    startDate: string;
    endDate: string;
  }): Promise<ConnectorResult> {
    const response = await this.client.send(
      new GetAnomaliesCommand({
        DateInterval: { StartDate: input.startDate, EndDate: input.endDate },
      }),
    );
    const anomalies = response.Anomalies ?? [];
    return {
      type: 'anomaly',
      summary: `${String(anomalies.length)} cost anomaly/anomalies detected between ${input.startDate} and ${input.endDate}.`,
      data: anomalies,
    };
  }

  public async getSavingsPlansUtilization(input: {
    startDate: string;
    endDate: string;
  }): Promise<ConnectorResult> {
    const response = await this.client.send(
      new GetSavingsPlansUtilizationCommand({
        TimePeriod: { Start: input.startDate, End: input.endDate },
      }),
    );
    const utilizationPercent = response.Total?.Utilization?.UtilizationPercentage ?? 'unknown';
    return {
      type: 'ri_sp',
      summary: `Savings Plans utilization ${input.startDate}..${input.endDate}: ${utilizationPercent}%.`,
      data: response.Total ?? {},
    };
  }

  public async getReservationUtilization(input: {
    startDate: string;
    endDate: string;
  }): Promise<ConnectorResult> {
    const response = await this.client.send(
      new GetReservationUtilizationCommand({
        TimePeriod: { Start: input.startDate, End: input.endDate },
      }),
    );
    const utilizationPercent = response.Total?.UtilizationPercentage ?? 'unknown';
    return {
      type: 'ri_sp',
      summary: `Reserved Instance utilization ${input.startDate}..${input.endDate}: ${utilizationPercent}%.`,
      data: response.Total ?? {},
    };
  }

  public async getRightsizingRecommendations(input: {
    service: 'AmazonEC2' | 'AmazonRDS';
  }): Promise<ConnectorResult> {
    const response = await this.client.send(
      new GetRightsizingRecommendationCommand({ Service: input.service }),
    );
    const recommendations = response.RightsizingRecommendations ?? [];
    return {
      type: 'cost_explorer',
      summary: `${String(recommendations.length)} rightsizing recommendation(s) for ${input.service}.`,
      data: recommendations,
    };
  }
}

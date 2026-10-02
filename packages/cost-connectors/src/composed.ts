import type { NormalizedCostReport } from '../../schemas/src/index.js';
import type { CostToolName } from '../../schemas/src/index.js';
import type {
  ConnectorResult,
  ReadOnlyCostConnector,
} from '../../agent-sdk-runtime/src/tool-server.js';
import type { CostExplorerConnector } from './cost-explorer.js';
import type { ResourceDescribeConnector } from './resource-describe.js';
import type { PriorReportsConnector } from './prior-reports.js';
import type { CloudWatchConnector } from './cloudwatch.js';
import type { CloudTrailConnector } from './cloudtrail.js';

export interface ComposedCostConnectorDependencies {
  report: NormalizedCostReport;
  costExplorer: CostExplorerConnector;
  resources: ResourceDescribeConnector;
  priorReports: PriorReportsConnector;
  cloudwatch: CloudWatchConnector;
  cloudtrail: CloudTrailConnector;
}

/** Adapted from paco-troubleshoot-agent's `buildComposedAwsConnector` — dispatches by tool name to the right sub-connector. */
export function buildComposedCostConnector(
  dependencies: ComposedCostConnectorDependencies,
): ReadOnlyCostConnector {
  return {
    execute: (
      toolName: CostToolName,
      input: Readonly<Record<string, unknown>>,
    ): Promise<ConnectorResult> => {
      switch (toolName) {
        case 'get_report':
          return Promise.resolve({
            type: 'historical',
            summary: `Report for ${dependencies.report.reportDate}: ${String(dependencies.report.lines.length)} line(s).`,
            data: dependencies.report,
          });
        case 'get_cost_and_usage':
          return dependencies.costExplorer.getCostAndUsage(input as never);
        case 'get_cost_anomalies':
          return dependencies.costExplorer.getCostAnomalies(input as never);
        case 'get_savings_plans_utilization':
          return dependencies.costExplorer.getSavingsPlansUtilization(input as never);
        case 'get_reservation_utilization':
          return dependencies.costExplorer.getReservationUtilization(input as never);
        case 'get_rightsizing_recommendations':
          return dependencies.costExplorer.getRightsizingRecommendations(input as never);
        case 'describe_resources':
          return dependencies.resources.describeResources(input as never);
        case 'get_prior_reports':
          return dependencies.priorReports.getPriorReports(input as never);
        case 'list_cloudwatch_metrics':
          return dependencies.cloudwatch.listMetrics(input as never);
        case 'get_cloudwatch_metric':
          return dependencies.cloudwatch.getMetricData(input as never);
        case 'get_cloudtrail_events':
          return dependencies.cloudtrail.lookupEvents(input as never);
      }
    },
  };
}

import {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import {
  FinalCostAnalysisSchema,
  GetReportInputSchema,
  GetCostAndUsageInputSchema,
  GetCostAnomaliesInputSchema,
  GetSavingsPlansUtilizationInputSchema,
  GetReservationUtilizationInputSchema,
  GetRightsizingRecommendationsInputSchema,
  DescribeResourcesInputSchema,
  GetPriorReportsInputSchema,
  ListCloudWatchMetricsInputSchema,
  GetCloudWatchMetricInputSchema,
  GetCloudTrailEventsInputSchema,
  type CostToolName,
  type CostToolEvidenceResult,
  type CostEvidenceType,
} from '../../schemas/src/index.js';
import { redactText, redactUnknown } from '../../core/src/index.js';

export interface ConnectorResult {
  type: CostToolEvidenceResult['type'];
  summary: string;
  data: unknown;
}

export interface ReadOnlyCostConnector {
  execute: (
    toolName: CostToolName,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<ConnectorResult>;
}

export interface EvidenceWriter {
  persist: (
    input: ConnectorResult & { toolName: CostToolName; metadata?: Record<string, unknown> },
  ) => Promise<string>;
}

export interface CostToolPolicy {
  reportDate: string;
  allowedAccountIds: readonly string[];
  earliestTime: string;
  latestTime: string;
  maxResultCharacters: number;
}

// Enough to reconstruct the exact AWS CLI call/console link a tool call
// corresponds to — neither value is part of any tool's own input, so they're
// threaded in separately rather than folded into CostToolPolicy.
export interface EvidenceLinkContext {
  region: string;
  costReportsTableName: string;
}

export interface ToolServerDependencies {
  connector: ReadOnlyCostConnector;
  evidenceWriter: EvidenceWriter;
  policy: CostToolPolicy;
  context: EvidenceLinkContext;
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/**
 * Adapted from paco-troubleshoot-agent's `authorize()`
 * (packages/agent-sdk-runtime/src/tool-server.ts) — same "deny anything
 * outside the resolved scope" shape, simplified to this domain's actual
 * dimensions: report date and an allowlisted set of AWS account IDs for
 * `describe_resources`, instead of repository/path/log-group/RDS-resource
 * allowlists that don't apply here.
 */
function authorize(input: Readonly<Record<string, unknown>>, policy: CostToolPolicy): void {
  if (input.reportDate !== policy.reportDate) throw new Error('REPORT_SCOPE_DENIED');
  if (typeof input.accountId === 'string' && !policy.allowedAccountIds.includes(input.accountId)) {
    throw new Error('ACCOUNT_DENIED');
  }
  if (typeof input.startDate === 'string' && typeof input.endDate === 'string') {
    const start = Date.parse(input.startDate);
    const end = Date.parse(input.endDate);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      start < Date.parse(policy.earliestTime) ||
      end > Date.parse(policy.latestTime)
    ) {
      throw new Error('TIME_WINDOW_DENIED');
    }
  }
}

function str(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function strArr(input: Readonly<Record<string, unknown>>, key: string): string[] | undefined {
  const value = input[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function ecsConsoleUrl(region: string, cluster: string, service: string): string {
  return `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${cluster}/services/${service}/health?region=${region}`;
}

function rdsConsoleUrl(region: string, id: string): string {
  return `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${id};is-cluster=false`;
}

function ec2ConsoleUrl(region: string, id: string): string {
  return `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#InstanceDetails:instanceId=${id}`;
}

function lambdaConsoleUrl(region: string, id: string): string {
  return `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${id}?tab=configure`;
}

function describeResourcesLink(
  input: Readonly<Record<string, unknown>>,
  region: string,
): { url?: string; detail: string; command: string } {
  const accountId = str(input, 'accountId') ?? 'unknown-account';
  const resourceType = str(input, 'resourceType') ?? 'unknown-resource-type';
  const resourceIds = strArr(input, 'resourceIds') ?? [];
  const detail = `${accountId} — ${resourceType} — ${resourceIds.join(', ')}`;
  const single = resourceIds.length === 1 ? resourceIds[0] : undefined;

  if (resourceType === 'ecs_service') {
    const byCluster = new Map<string, string[]>();
    for (const id of resourceIds) {
      const [cluster, service] = id.split('|');
      if (!cluster || !service) continue;
      byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), service]);
    }
    const command = [...byCluster.entries()]
      .map(
        ([cluster, services]) =>
          `aws ecs describe-services --cluster ${cluster} --services ${services.join(' ')} --region ${region}`,
      )
      .join(' && ');
    const singlePair = single?.split('|');
    const url =
      singlePair?.[0] && singlePair[1]
        ? ecsConsoleUrl(region, singlePair[0], singlePair[1])
        : undefined;
    return { detail, command, ...(url ? { url } : {}) };
  }
  if (resourceType === 'rds_instance') {
    const command = resourceIds
      .map(
        (id) => `aws rds describe-db-instances --db-instance-identifier ${id} --region ${region}`,
      )
      .join(' && ');
    return { detail, command, ...(single ? { url: rdsConsoleUrl(region, single) } : {}) };
  }
  if (resourceType === 'ec2_instance') {
    const command = `aws ec2 describe-instances --instance-ids ${resourceIds.join(' ')} --region ${region}`;
    return { detail, command, ...(single ? { url: ec2ConsoleUrl(region, single) } : {}) };
  }
  if (resourceType === 'lambda_function') {
    const command = resourceIds
      .map((id) => `aws lambda get-function-configuration --function-name ${id} --region ${region}`)
      .join(' && ');
    return { detail, command, ...(single ? { url: lambdaConsoleUrl(region, single) } : {}) };
  }
  return { detail, command: `# unrecognized resourceType: ${resourceType}` };
}

// Deterministic, built from the same authorized tool input the evidence
// itself came from — never from the model's own text — so a link/command in
// the live progress trail and the final evidence summary always point at
// what was actually requested. Every tool gets a `command` (the AWS
// CLI/DynamoDB-CLI equivalent of the SDK call `cost-connectors` actually
// makes); only `describe_resources` maps to a real, stable console deep
// link — Cost Explorer has no such scheme for arbitrary group-by/filter
// queries, so those stay command-only, same conservative call
// paco-troubleshoot-agent made for tools without a reliable console URL.
export function buildEvidenceLink(
  toolName: CostToolName,
  input: Readonly<Record<string, unknown>>,
  context: EvidenceLinkContext,
): { url?: string; detail: string; command: string } {
  const { region, costReportsTableName } = context;
  const reportDate = str(input, 'reportDate') ?? 'unknown-date';
  const startDate = str(input, 'startDate') ?? 'unknown-date';
  const endDate = str(input, 'endDate') ?? 'unknown-date';

  switch (toolName) {
    case 'get_report':
      return {
        detail: `report cache — ${reportDate}`,
        command: `aws dynamodb get-item --table-name ${costReportsTableName} --key '{"reportDate":{"S":"${reportDate}"}}' --region ${region}`,
      };
    case 'get_cost_and_usage': {
      const granularity = str(input, 'granularity') ?? 'DAILY';
      const groupBy = strArr(input, 'groupBy') ?? ['SERVICE'];
      const accountId = str(input, 'accountId');
      const groupByFlags = groupBy.map((key) => `Type=DIMENSION,Key=${key}`).join(' ');
      const filterFlag = accountId
        ? ` --filter '{"Dimensions":{"Key":"LINKED_ACCOUNT","Values":["${accountId}"]}}'`
        : '';
      return {
        detail: `${startDate}→${endDate}, ${granularity}, grouped by ${groupBy.join('/')}${accountId ? `, account ${accountId}` : ''}`,
        command: `aws ce get-cost-and-usage --time-period Start=${startDate},End=${endDate} --granularity ${granularity} --metrics UnblendedCost --group-by ${groupByFlags}${filterFlag}`,
      };
    }
    case 'get_cost_anomalies':
      return {
        detail: `${startDate}→${endDate}`,
        command: `aws ce get-anomalies --date-interval StartDate=${startDate},EndDate=${endDate}`,
      };
    case 'get_savings_plans_utilization':
      return {
        detail: `${startDate}→${endDate}`,
        command: `aws ce get-savings-plans-utilization --time-period Start=${startDate},End=${endDate}`,
      };
    case 'get_reservation_utilization':
      return {
        detail: `${startDate}→${endDate}`,
        command: `aws ce get-reservation-utilization --time-period Start=${startDate},End=${endDate}`,
      };
    case 'get_rightsizing_recommendations': {
      const service = str(input, 'service') ?? 'unknown-service';
      return {
        detail: service,
        command: `aws ce get-rightsizing-recommendation --service ${service}`,
      };
    }
    case 'describe_resources':
      return describeResourcesLink(input, region);
    case 'get_prior_reports': {
      const limit = typeof input.limit === 'number' ? input.limit : 0;
      return {
        detail: `${String(limit)} day(s) before ${reportDate}`,
        command: `aws dynamodb get-item --table-name ${costReportsTableName} --key '{"reportDate":{"S":"<date>"}}' --region ${region}  # repeated for each of the ${String(limit)} day(s) before ${reportDate}`,
      };
    }
    case 'list_cloudwatch_metrics': {
      const accountId = str(input, 'accountId') ?? 'unknown-account';
      const namespace = str(input, 'namespace') ?? 'unknown-namespace';
      const metricNamePrefix = str(input, 'metricNamePrefix');
      return {
        detail: `${accountId} — ${namespace}${metricNamePrefix ? ` — prefix ${metricNamePrefix}` : ''}`,
        command: `aws cloudwatch list-metrics --namespace ${namespace}${metricNamePrefix ? ` --metric-name ${metricNamePrefix}` : ''} --region ${region}`,
      };
    }
    case 'get_cloudwatch_metric': {
      const accountId = str(input, 'accountId') ?? 'unknown-account';
      const namespace = str(input, 'namespace') ?? 'unknown-namespace';
      const metricName = str(input, 'metricName') ?? 'unknown-metric';
      const statistic = str(input, 'statistic') ?? 'Sum';
      const period = typeof input.period === 'number' ? input.period : 0;
      return {
        detail: `${accountId} — ${namespace}/${metricName}, ${startDate}→${endDate}`,
        command: `aws cloudwatch get-metric-data --start-time ${startDate} --end-time ${endDate} --metric-data-queries '[{"Id":"m1","MetricStat":{"Metric":{"Namespace":"${namespace}","MetricName":"${metricName}"},"Period":${String(period)},"Stat":"${statistic}"}}]' --region ${region}`,
      };
    }
    case 'get_cloudtrail_events': {
      const accountId = str(input, 'accountId') ?? 'unknown-account';
      return {
        detail: `${accountId} — ${startDate}→${endDate}`,
        command: `aws cloudtrail lookup-events --start-time ${startDate} --end-time ${endDate} --region ${region}`,
      };
    }
  }
}

function compactData(value: unknown, limit: number): { data: unknown; truncated: boolean } {
  const sanitized = redactUnknown(value);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= limit) return { data: sanitized, truncated: false };
  return { data: { truncatedJson: serialized.slice(0, limit) }, truncated: true };
}

// Matches a bare policy-denial code and a connector's own "CODE: httpStatus"
// shape — same pattern and rationale as paco-troubleshoot-agent's
// `SAFE_ERROR_CODE_PATTERN` (an HTTP status is safe to surface, never a
// secret; losing it makes every real AWS API failure indistinguishable).
const SAFE_ERROR_CODE_PATTERN = /^[A-Z_]+(: \d{3})?$/;

interface SafeErrorResult {
  [key: string]: unknown;
  content: [{ type: 'text'; text: string }];
  structuredContent: { error: { code: string; retryable: boolean } };
  isError: true;
}

function safeError(error: unknown): SafeErrorResult {
  const code =
    error instanceof Error && SAFE_ERROR_CODE_PATTERN.test(error.message)
      ? error.message
      : 'CONNECTOR_ERROR';
  return {
    content: [{ type: 'text' as const, text: `Tool request failed safely: ${code}` }],
    structuredContent: { error: { code, retryable: code === 'CONNECTOR_ERROR' } },
    isError: true,
  };
}

// Cosmetic only, used for a failed call's catalog entry — never load-bearing
// for evidence validation, since a failed call never returns an evidenceId
// for the model to cite (`validateCostAnalysisEvidence` only looks up IDs
// the model's own claims reference).
const EVIDENCE_TYPE_BY_TOOL: Record<CostToolName, CostEvidenceType> = {
  get_report: 'historical',
  get_cost_and_usage: 'cost_explorer',
  get_cost_anomalies: 'anomaly',
  get_savings_plans_utilization: 'ri_sp',
  get_reservation_utilization: 'ri_sp',
  get_rightsizing_recommendations: 'cost_explorer',
  describe_resources: 'resource',
  get_prior_reports: 'historical',
  list_cloudwatch_metrics: 'cloudwatch_metric',
  get_cloudwatch_metric: 'cloudwatch_metric',
  get_cloudtrail_events: 'cloudtrail_event',
};

interface EvidenceToolSuccess {
  [key: string]: unknown;
  content: [{ type: 'text'; text: string }];
  structuredContent: CostToolEvidenceResult;
  isError: false;
}

export async function executeEvidenceTool(
  toolName: CostToolName,
  input: Record<string, unknown>,
  dependencies: ToolServerDependencies,
): Promise<EvidenceToolSuccess | SafeErrorResult> {
  const link = buildEvidenceLink(toolName, input, dependencies.context);
  try {
    authorize(input, dependencies.policy);
    const result = await dependencies.connector.execute(toolName, input);
    const compact = compactData(result.data, dependencies.policy.maxResultCharacters);
    const summary = redactText(result.summary).slice(0, 2_000);
    const evidenceId = await dependencies.evidenceWriter.persist({
      toolName,
      type: result.type,
      summary,
      data: compact.data,
      metadata: {
        toolName,
        detail: link.detail,
        command: link.command,
        ok: true,
        ...(link.url ? { url: link.url } : {}),
      },
    });
    const structuredContent: CostToolEvidenceResult = {
      evidenceId,
      type: result.type,
      summary,
      data: compact.data,
      truncated: compact.truncated,
    };
    return {
      content: [{ type: 'text' as const, text: `Evidence ${evidenceId} collected.` }],
      structuredContent,
      isError: false,
    };
  } catch (error) {
    const failure = safeError(error);
    try {
      // Best-effort: a catalog-write failure here must never mask the real
      // tool error returned to the model below.
      await dependencies.evidenceWriter.persist({
        toolName,
        type: EVIDENCE_TYPE_BY_TOOL[toolName],
        summary: `Tool call failed: ${failure.structuredContent.error.code}`,
        data: null,
        metadata: {
          toolName,
          detail: link.detail,
          command: link.command,
          ok: false,
          error: failure.structuredContent.error.code,
          ...(link.url ? { url: link.url } : {}),
        },
      });
    } catch {
      // ignore — see comment above
    }
    return failure;
  }
}

function handlerFor(toolName: CostToolName, dependencies: ToolServerDependencies) {
  return (input: Record<string, unknown>) => executeEvidenceTool(toolName, input, dependencies);
}

// A qualifying call is one that could actually populate serviceBreakdown —
// DAILY granularity grouped by SERVICE — regardless of whether it succeeded,
// so a real CONNECTOR_ERROR doesn't trap the model in an unwinnable retry
// loop; only whether it was attempted matters.
function isDailyServiceBreakdownAttempt(input: Readonly<Record<string, unknown>>): boolean {
  return input.granularity === 'DAILY' && (strArr(input, 'groupBy') ?? []).includes('SERVICE');
}

/**
 * A real MCP tool for submitting the final answer, registered alongside the
 * evidence tools — not the Agent SDK's `outputFormat: {type: 'json_schema'}`
 * mechanism. Ported rationale from paco-troubleshoot-agent's
 * `submitFinalAnalysisTool` (tool-server.ts): that mechanism silently starves
 * the model of every other tool for models/gateways without native
 * structured-output support, and `_meta: {'claude/endTurn': true}`'s
 * documented short-circuit behavior does not reliably occur — `runner.ts`
 * here reads the submitted analysis directly off this tool's `tool_use`
 * block instead of depending on it.
 *
 * `hasAttemptedDailyServiceBreakdown` is a per-session closure flag (set in
 * `buildCostTools` below) — a guided, one-time rejection instead of the
 * 2026-09-29 incident's silent, unrecoverable MCP schema-validation failure:
 * a model that never called get_cost_and_usage with DAILY/SERVICE now gets a
 * clear instruction to go do that, rather than a raw zod error it couldn't
 * act on.
 */
function buildSubmitFinalAnalysisTool(
  hasAttemptedDailyServiceBreakdown: () => boolean,
): SdkMcpToolDefinition<typeof FinalCostAnalysisSchema.shape> {
  return {
    name: 'submit_final_analysis',
    description:
      'Submit the completed cost investigation exactly once, when finished (with or without an identified driver). This ends the investigation.',
    inputSchema: FinalCostAnalysisSchema.shape,
    _meta: { 'claude/endTurn': true },
    handler: (input: Record<string, unknown>) => {
      const serviceBreakdown = Array.isArray(input.serviceBreakdown) ? input.serviceBreakdown : [];
      if (serviceBreakdown.length === 0 && !hasAttemptedDailyServiceBreakdown()) {
        return Promise.resolve({
          content: [
            {
              type: 'text' as const,
              text: 'Rejected: serviceBreakdown is empty and you have not yet called get_cost_and_usage with granularity="DAILY" and groupBy including "SERVICE". Call it now for the report date and the two days before it, copy the per-service daily totals into serviceBreakdown citing that call\'s evidence ID, then resubmit. If that call genuinely returns nothing usable, make it anyway and you may resubmit with an empty serviceBreakdown afterward.',
            },
          ],
          isError: true,
        });
      }
      return Promise.resolve({
        content: [{ type: 'text' as const, text: 'Final analysis submitted.' }],
        structuredContent: input,
      });
    },
  };
}

export function buildCostTools(dependencies: ToolServerDependencies) {
  let dailyServiceBreakdownAttempted = false;

  return [
    tool(
      'get_report',
      'Get the parsed cost report for this thread.',
      GetReportInputSchema.shape,
      handlerFor('get_report', dependencies),
      { annotations },
    ),
    tool(
      'get_cost_and_usage',
      'Get a Cost Explorer breakdown for a bounded date window.',
      GetCostAndUsageInputSchema.shape,
      (input: Record<string, unknown>) => {
        if (isDailyServiceBreakdownAttempt(input)) dailyServiceBreakdownAttempted = true;
        return executeEvidenceTool('get_cost_and_usage', input, dependencies);
      },
      { annotations },
    ),
    tool(
      'get_cost_anomalies',
      'Get Cost Anomaly Detection results for a bounded date window.',
      GetCostAnomaliesInputSchema.shape,
      handlerFor('get_cost_anomalies', dependencies),
      { annotations },
    ),
    tool(
      'get_savings_plans_utilization',
      'Get Savings Plans coverage/utilization for a bounded date window.',
      GetSavingsPlansUtilizationInputSchema.shape,
      handlerFor('get_savings_plans_utilization', dependencies),
      { annotations },
    ),
    tool(
      'get_reservation_utilization',
      'Get Reserved Instance coverage/utilization for a bounded date window.',
      GetReservationUtilizationInputSchema.shape,
      handlerFor('get_reservation_utilization', dependencies),
      { annotations },
    ),
    tool(
      'get_rightsizing_recommendations',
      'Get Cost Explorer rightsizing recommendations for EC2 or RDS.',
      GetRightsizingRecommendationsInputSchema.shape,
      handlerFor('get_rightsizing_recommendations', dependencies),
      { annotations },
    ),
    tool(
      'describe_resources',
      'Describe allowlisted read-only resource metadata (ECS/RDS/EC2/Lambda) in an allowlisted account.',
      DescribeResourcesInputSchema.shape,
      handlerFor('describe_resources', dependencies),
      { annotations },
    ),
    tool(
      'get_prior_reports',
      'Get bounded prior cost report summaries for trend context.',
      GetPriorReportsInputSchema.shape,
      handlerFor('get_prior_reports', dependencies),
      { annotations },
    ),
    tool(
      'list_cloudwatch_metrics',
      'Discover exact CloudWatch metric names/dimensions in a namespace (e.g. AWS/Lambda, AWS/ApiGateway, AWS/WAFV2, AWS/Redshift, AWS/Logs) in an allowlisted account, before calling get_cloudwatch_metric.',
      ListCloudWatchMetricsInputSchema.shape,
      handlerFor('list_cloudwatch_metrics', dependencies),
      { annotations },
    ),
    tool(
      'get_cloudwatch_metric',
      'Get CloudWatch metric datapoints for a bounded date window (Lambda concurrency/invocations, API Gateway request counts, WAF allowed/blocked counts, Redshift concurrency-scaling seconds, CloudWatch Logs incoming bytes, etc.) in an allowlisted account.',
      GetCloudWatchMetricInputSchema.shape,
      handlerFor('get_cloudwatch_metric', dependencies),
      { annotations },
    ),
    tool(
      'get_cloudtrail_events',
      'Look up CloudTrail management events (who changed what, when) for a bounded date window in an allowlisted account.',
      GetCloudTrailEventsInputSchema.shape,
      handlerFor('get_cloudtrail_events', dependencies),
      { annotations },
    ),
    buildSubmitFinalAnalysisTool(() => dailyServiceBreakdownAttempted),
  ];
}

export function buildCostToolServer(dependencies: ToolServerDependencies) {
  return createSdkMcpServer({
    name: 'cost',
    version: '1.0.0',
    instructions:
      'Read-only AWS cost evidence tools. Returned structuredContent is sanitized and evidence-linked.',
    tools: buildCostTools(dependencies),
    // Without this, tools default to deferred-behind-tool-search — see
    // paco-troubleshoot-agent's identical comment (tool-server.ts).
    alwaysLoad: true,
  });
}

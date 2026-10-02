import { z } from 'zod';
import { CostEvidenceTypeSchema } from './cost-analysis.js';

const ReportScopedSchema = z
  .object({ reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();
const DateWindowSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GetReportInputSchema = ReportScopedSchema;

export const GetCostAndUsageInputSchema = ReportScopedSchema.extend({
  ...DateWindowSchema.shape,
  granularity: z.enum(['DAILY', 'MONTHLY']),
  // CE's GetCostAndUsage accepts at most two GroupBy dimensions per call.
  groupBy: z
    .array(z.enum(['SERVICE', 'USAGE_TYPE', 'LINKED_ACCOUNT', 'REGION']))
    .min(1)
    .max(2),
  accountId: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
}).strict();

export const GetCostAnomaliesInputSchema = ReportScopedSchema.extend({
  ...DateWindowSchema.shape,
}).strict();

export const GetSavingsPlansUtilizationInputSchema = ReportScopedSchema.extend({
  ...DateWindowSchema.shape,
}).strict();

export const GetReservationUtilizationInputSchema = ReportScopedSchema.extend({
  ...DateWindowSchema.shape,
}).strict();

export const GetRightsizingRecommendationsInputSchema = ReportScopedSchema.extend({
  service: z.enum(['AmazonEC2', 'AmazonRDS']),
}).strict();

export const DescribeResourcesInputSchema = ReportScopedSchema.extend({
  accountId: z.string().regex(/^\d{12}$/),
  resourceType: z.enum(['ecs_service', 'rds_instance', 'ec2_instance', 'lambda_function']),
  resourceIds: z.array(z.string().min(1)).min(1).max(20),
}).strict();

export const GetPriorReportsInputSchema = ReportScopedSchema.extend({
  limit: z.number().int().positive().max(10),
}).strict();

const CloudWatchDimensionSchema = z.object({ name: z.string().min(1), value: z.string().min(1) });

export const ListCloudWatchMetricsInputSchema = ReportScopedSchema.extend({
  accountId: z.string().regex(/^\d{12}$/),
  namespace: z.string().min(1),
  metricNamePrefix: z.string().min(1).optional(),
}).strict();

export const GetCloudWatchMetricInputSchema = ReportScopedSchema.extend({
  ...DateWindowSchema.shape,
  accountId: z.string().regex(/^\d{12}$/),
  namespace: z.string().min(1),
  metricName: z.string().min(1),
  dimensions: z.array(CloudWatchDimensionSchema).min(0).max(10),
  period: z.number().int().positive(),
  statistic: z.enum(['Sum', 'Average', 'Maximum', 'Minimum', 'SampleCount']),
}).strict();

export const GetCloudTrailEventsInputSchema = ReportScopedSchema.extend({
  ...DateWindowSchema.shape,
  accountId: z.string().regex(/^\d{12}$/),
  lookupAttributes: z
    .array(
      z.object({
        attributeKey: z.enum(['EventName', 'ResourceName', 'Username']),
        attributeValue: z.string().min(1),
      }),
    )
    .min(1)
    .max(5),
}).strict();

export const CostToolNameSchema = z.enum([
  'get_report',
  'get_cost_and_usage',
  'get_cost_anomalies',
  'get_savings_plans_utilization',
  'get_reservation_utilization',
  'get_rightsizing_recommendations',
  'describe_resources',
  'get_prior_reports',
  'list_cloudwatch_metrics',
  'get_cloudwatch_metric',
  'get_cloudtrail_events',
]);

export const CostToolEvidenceResultSchema = z
  .object({
    evidenceId: z.string().regex(/^EV-[A-Za-z0-9_-]+$/),
    type: CostEvidenceTypeSchema,
    summary: z.string().min(1).max(2_000),
    data: z.unknown(),
    truncated: z.boolean(),
  })
  .strict();

export type CostToolName = z.infer<typeof CostToolNameSchema>;
export type CostToolEvidenceResult = z.infer<typeof CostToolEvidenceResultSchema>;

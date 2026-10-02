import { Stack, aws_iam as iam } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Read-only Cost Explorer/Savings Plans/Compute Optimizer actions for the
 * ECS worker task role. None of these actions has resource-level IAM
 * support in AWS's model — `resources: ['*']` is the ceiling of least
 * privilege AWS allows for a read-only call of this shape, not a broadened
 * grant. No write/mutation action is ever included here — see
 * docs/adr/0001-dedicated-bot-and-readonly-boundary.md.
 */
export function costExplorerReadOnlyPolicyStatements(): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      actions: [
        'ce:GetCostAndUsage',
        'ce:GetAnomalies',
        'ce:GetAnomalyMonitors',
        'ce:GetSavingsPlansUtilization',
        'ce:GetReservationUtilization',
        'ce:GetRightsizingRecommendation',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({ actions: ['savingsplans:DescribeSavingsPlans'], resources: ['*'] }),
    new iam.PolicyStatement({
      actions: [
        'compute-optimizer:GetEC2InstanceRecommendations',
        'compute-optimizer:GetRDSDatabaseRecommendations',
      ],
      resources: ['*'],
    }),
  ];
}

/** Grants `secretsmanager:GetSecretValue` for exact secret ARNs only — never a wildcard. Ported verbatim from paco-troubleshoot-agent. */
export function exactSecretReadStatement(secretArns: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: secretArns,
  });
}

/**
 * Scopes `sts:AssumeRole` to the exact cross-account read-only role in each
 * allowlisted linked account (`ResourceDescribeConnector`'s
 * `buildCrossAccountClientFactory`) — never a wildcard account or role name.
 * The assumed role itself, and the describe-only permissions it grants, are
 * provisioned out of band in each linked account (see
 * COST_AGENT_BUILD_SPEC.md §8) — this statement only lets the worker task
 * reach it, never grants what it can do there.
 */
export function crossAccountAssumeRoleStatement(roleArns: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: roleArns });
}

const INFERENCE_PROFILE_PREFIXES = ['us.', 'eu.', 'apac.', 'global.'];

/** Grants `bedrock:InvokeModel`/`InvokeModelWithResponseStream` scoped to one exact foundation-model ID/ARN or cross-region inference profile ID. Ported verbatim from paco-troubleshoot-agent. */
export function bedrockModelInvokeStatement(
  scope: Construct,
  modelId: string,
): iam.PolicyStatement {
  const actions = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'];
  if (modelId.startsWith('arn:')) {
    return new iam.PolicyStatement({ actions, resources: [modelId] });
  }
  const { partition, region, account } = Stack.of(scope);
  const inferenceProfilePrefix = INFERENCE_PROFILE_PREFIXES.find((prefix) =>
    modelId.startsWith(prefix),
  );
  if (inferenceProfilePrefix) {
    const underlyingModelId = modelId.slice(inferenceProfilePrefix.length);
    return new iam.PolicyStatement({
      actions,
      resources: [
        `arn:${partition}:bedrock:${region}:${account}:inference-profile/${modelId}`,
        `arn:${partition}:bedrock:*::foundation-model/${underlyingModelId}`,
      ],
    });
  }
  return new iam.PolicyStatement({
    actions,
    resources: [`arn:${partition}:bedrock:${region}::foundation-model/${modelId}`],
  });
}

/**
 * This account has GuardDuty Runtime Monitoring's ECS Fargate agent
 * management enabled account-wide (confirmed live in paco-troubleshoot-agent's
 * identical estate — see its `guardDutyAgentEcrPullStatements` comment),
 * which auto-injects a security-agent sidecar into every new Fargate task.
 * Without this grant the task's execution role can't pull that sidecar's
 * image from its own cross-account ECR repo, and the task fails closed with
 * CannotPullContainerError. Ported verbatim.
 */
export function guardDutyAgentEcrPullStatements(scope: Construct): iam.PolicyStatement[] {
  const { partition, region } = Stack.of(scope);
  return [
    new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
    new iam.PolicyStatement({
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      resources: [
        `arn:${partition}:ecr:${region}:892757235363:repository/aws-guardduty-agent-fargate`,
      ],
    }),
  ];
}

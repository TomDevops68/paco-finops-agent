import type { aws_secretsmanager as secretsmanager } from 'aws-cdk-lib';
import {
  Stack,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { bedrockModelInvokeStatement, guardDutyAgentEcrPullStatements } from './iam-policies.js';

/**
 * Standalone, persistent LiteLLM gateway service, ported from
 * paco-troubleshoot-agent's `litellm-service.ts` (docs/adr/0002). Deliberately
 * not a sidecar in the per-investigation worker task: a shared, always-on
 * service is what makes LiteLLM's rate-limiting/budget-tracking meaningful
 * across concurrent investigations, and keeps Bedrock IAM access off the
 * ephemeral worker task role (docs/adr/0001's read-only-boundary isolation).
 */
export interface LiteLLMServiceProps {
  cluster: ecs.Cluster;
  /** The investigation worker task's security group (harness-state-machine.ts), so ingress here can be scoped to exactly that group. */
  workerSecurityGroup: ec2.ISecurityGroup;
  /** The real Bedrock foundation-model ID/ARN config/litellm.yaml routes to — scopes this service's own task-role IAM grant, never the worker's. */
  upstreamBedrockModelId: string;
  /** Cloud Map private DNS namespace name for the cluster, e.g. `cost-agent-dev.local`. Created if the cluster has none yet. */
  cloudMapNamespaceName: string;
  /** `CostAgent-<env>-litellm` (apps/infra/lib/stacks.ts IntegrationStack), injected out of band like the model/Slack secrets. */
  litellmSecret: secretsmanager.Secret;
}

export interface LiteLLMServiceResult {
  service: ecs.FargateService;
  /** e.g. http://litellm.cost-agent-dev.local:4000 — feeds config/harness.yaml-driven worker env (LITELLM_BASE_URL). */
  baseUrl: string;
  securityGroup: ec2.SecurityGroup;
}

const CONTAINER_PORT = 4000;

export function buildLiteLLMService(
  scope: Construct,
  props: LiteLLMServiceProps,
): LiteLLMServiceResult {
  const executionRole = new iam.Role(scope, 'LiteLLMExecutionRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });
  props.litellmSecret.grantRead(executionRole);
  for (const statement of guardDutyAgentEcrPullStatements(scope))
    executionRole.addToPolicy(statement);

  const taskRole = new iam.Role(scope, 'LiteLLMTaskRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });
  taskRole.addToPolicy(bedrockModelInvokeStatement(scope, props.upstreamBedrockModelId));

  const taskDefinition = new ecs.FargateTaskDefinition(scope, 'LiteLLMTaskDefinition', {
    cpu: 512,
    memoryLimitMiB: 1024,
    executionRole,
    taskRole,
  });

  const logGroup = new logs.LogGroup(scope, 'LiteLLMLogGroup', {
    retention: logs.RetentionDays.ONE_MONTH,
  });

  taskDefinition.addContainer('LiteLLMProxy', {
    // Pinned to amd64 (Fargate's default runtimePlatform) regardless of the
    // deploying machine's native arch — otherwise a build on Apple Silicon
    // produces an arm64 image Fargate can't exec.
    image: ecs.ContainerImage.fromAsset(process.cwd(), {
      file: 'apps/litellm-proxy/Dockerfile',
      platform: ecr_assets.Platform.LINUX_AMD64,
    }),
    logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'litellm' }),
    // ECS does not auto-inject AWS_REGION the way Lambda does; config/litellm.yaml needs it explicitly.
    environment: { AWS_REGION: Stack.of(scope).region },
    // Explicit 'apiKey' field selector: the secret's SecretString is the JSON
    // blob {apiKey}, and the worker authenticates with the bare key value
    // (apps/agent-worker/src/main.ts) — without a selector this env var
    // would be the raw JSON string instead.
    secrets: {
      LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(
        props.litellmSecret as secretsmanager.ISecret,
        'apiKey',
      ),
    },
    portMappings: [{ containerPort: CONTAINER_PORT }],
    // No container-level health check: curl availability on the upstream
    // ghcr.io/berriai/litellm image isn't verified, and a wrong health check
    // would fail the service closed. ECS falls back to task running-state.
  });

  const securityGroup = new ec2.SecurityGroup(scope, 'LiteLLMSecurityGroup', {
    vpc: props.cluster.vpc,
    description: 'LiteLLM gateway: inbound only from the investigation worker task.',
    allowAllOutbound: true,
  });
  securityGroup.addIngressRule(
    props.workerSecurityGroup,
    ec2.Port.tcp(CONTAINER_PORT),
    'Investigation worker to LiteLLM gateway',
  );

  if (!props.cluster.defaultCloudMapNamespace) {
    props.cluster.addDefaultCloudMapNamespace({ name: props.cloudMapNamespaceName });
  }

  const service = new ecs.FargateService(scope, 'LiteLLMService', {
    cluster: props.cluster as ecs.ICluster,
    taskDefinition,
    desiredCount: 1,
    // Single-task internal gateway: brief downtime during a rolling deploy
    // is acceptable, so don't require a second task to be healthy first.
    minHealthyPercent: 0,
    // Public, IGW-routed subnets — no NAT Gateway (docs/adr/0003). Only the
    // worker task's security group is allowed inbound on 4000 (below);
    // a public IP on this task's ENI doesn't change that.
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    assignPublicIp: true,
    securityGroups: [securityGroup],
    cloudMapOptions: { name: 'litellm' },
  });

  return {
    service,
    baseUrl: `http://litellm.${props.cloudMapNamespaceName}:${String(CONTAINER_PORT)}`,
    securityGroup,
  };
}

import * as cdk from 'aws-cdk-lib';
import { resolve } from 'node:path';
import {
  aws_apigateway as apigateway,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { createNodeFunction } from './node-function.js';
import { exactSecretReadStatement } from './iam-policies.js';
import { buildHarnessStateMachine, type HarnessConfigValues } from './harness-state-machine.js';
import { buildLiteLLMService } from './litellm-service.js';

interface StackProps extends cdk.StackProps {
  environment: string;
}

const retention = logs.RetentionDays.ONE_MONTH;

export const tags = (stack: cdk.Stack, environment: string) => {
  cdk.Tags.of(stack).add('Project', 'paco-cost-agent');
  cdk.Tags.of(stack).add('Environment', environment);
};

/** Holds `config/account-map.yaml` and `config/playbooks.yaml` so both stay updateable without a redeploy — same role ContextStack plays in paco-troubleshoot-agent, without the chunk-indexing system this domain doesn't need. */
export class ConfigStack extends cdk.Stack {
  readonly bucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    tags(this, props.environment);
    this.bucket = new s3.Bucket(this, 'ConfigBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(90) }],
    });
    new s3deploy.BucketDeployment(this, 'ConfigDeployment', {
      destinationBucket: this.bucket,
      sources: [
        s3deploy.Source.asset(resolve(process.cwd(), 'config'), {
          exclude: ['harness.yaml', 'context-assets/**'],
        }),
      ],
      prune: false,
    });
    new cdk.CfnOutput(this, 'ConfigBucketName', { value: this.bucket.bucketName });
  }
}

export class DataStack extends cdk.Stack {
  readonly costReports: dynamodb.Table;
  readonly analysisCache: dynamodb.Table;
  readonly control: dynamodb.Table;
  readonly sessions: dynamodb.Table;
  readonly sessionBucket: s3.Bucket;
  readonly evidenceBucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    tags(this, props.environment);
    const table = (name: string, partitionKey: string, ttl?: string) =>
      new dynamodb.Table(this, name, {
        partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        ...(ttl ? { timeToLiveAttribute: ttl } : {}),
      });
    this.costReports = table('CostReportsTable', 'reportDate', 'expiresAt');
    this.analysisCache = table('AnalysisCacheTable', 'lineFingerprint', 'expiresAt');
    this.control = table('ControlTable', 'controlKey', 'expiresAt');
    this.sessions = table('AgentSessionsTable', 'sessionKey', 'expiresAt');
    this.sessions.addGlobalSecondaryIndex({
      indexName: 'ByProjectKey',
      partitionKey: { name: 'projectKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.sessionBucket = new s3.Bucket(this, 'AgentSessionBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });
    this.evidenceBucket = new s3.Bucket(this, 'EvidenceBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      lifecycleRules: [
        { prefix: 'evidence/', expiration: cdk.Duration.days(30) },
        { prefix: 'worker-results/', expiration: cdk.Duration.days(14) },
      ],
    });
  }
}

export interface IngestionStackProps extends StackProps {
  costReportsTable: dynamodb.Table;
  controlTable: dynamodb.Table;
  analysisCacheTable: dynamodb.Table;
  configBucket: s3.Bucket;
  lockTtlSeconds: number;
  /** Must outlive the slowest of a report round's N parallel per-line investigations, not just one line's lock — see harness fargate.taskTimeoutSeconds. */
  batchTtlSeconds: number;
  concurrency: { maxGlobalInvestigations: number; maxPerReportInvestigations: number };
  significantChangePercent: number;
  /** Report line labels to never enqueue an investigation for — see isNotable's comment. */
  excludedLabels: string[];
  slackSecret: secretsmanager.Secret;
  slackSigningSecret: secretsmanager.Secret;
}

export class IngestionStack extends cdk.Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly slackEventsUrl: string;
  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);
    tags(this, props.environment);
    this.deadLetterQueue = new sqs.Queue(this, 'InvestigationDLQ', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, 'InvestigationQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    // A human tags the agent under the paco-daily-cost-report-posted
    // message; this Lambda verifies the request, parses that thread's root
    // message, coordinates lock/concurrency, and enqueues an investigation
    // per notable line that needs one.
    const slackEventsFn = createNodeFunction(this, 'SlackEventsFunction', {
      functionName: `CostAgent-${props.environment}-slack-events`,
      entry: 'apps/functions/slack-events/index.ts',
      environment: {
        COST_REPORTS_TABLE: props.costReportsTable.tableName,
        CONTROL_TABLE: props.controlTable.tableName,
        ANALYSIS_CACHE_TABLE: props.analysisCacheTable.tableName,
        CONFIG_BUCKET: props.configBucket.bucketName,
        INVESTIGATION_QUEUE_URL: this.queue.queueUrl,
        LOCK_TTL_MS: String(props.lockTtlSeconds * 1000),
        BATCH_TTL_MS: String(props.batchTtlSeconds * 1000),
        MAX_GLOBAL_INVESTIGATIONS: String(props.concurrency.maxGlobalInvestigations),
        MAX_PER_REPORT_INVESTIGATIONS: String(props.concurrency.maxPerReportInvestigations),
        SIGNIFICANT_CHANGE_PERCENT: String(props.significantChangePercent),
        EXCLUDED_LABELS_JSON: JSON.stringify(props.excludedLabels),
        SLACK_SECRET_ARN: props.slackSecret.secretArn,
        SLACK_SIGNING_SECRET_ARN: props.slackSigningSecret.secretArn,
      },
    });
    props.costReportsTable.grantReadWriteData(slackEventsFn);
    props.controlTable.grantReadWriteData(slackEventsFn);
    props.analysisCacheTable.grantReadData(slackEventsFn);
    props.configBucket.grantRead(slackEventsFn);
    this.queue.grantSendMessages(slackEventsFn);
    slackEventsFn.addToRolePolicy(
      exactSecretReadStatement([props.slackSecret.secretArn, props.slackSigningSecret.secretArn]),
    );

    const slackEventsApi = new apigateway.LambdaRestApi(this, 'SlackEventsApi', {
      handler: slackEventsFn,
      proxy: false,
      deployOptions: { stageName: props.environment },
    });
    slackEventsApi.root.addResource('slack-events').addMethod('POST');
    this.slackEventsUrl = `${slackEventsApi.url}slack-events`;

    new cdk.CfnOutput(this, 'InvestigationQueueUrl', { value: this.queue.queueUrl });
    // Paste into the cost agent's Slack app's Event Subscriptions "Request URL" field.
    new cdk.CfnOutput(this, 'SlackEventsUrl', { value: this.slackEventsUrl });
  }
}

export interface NetworkConfigValues {
  vpcId: string;
  availabilityZones: string[];
  /** Public, IGW-routed subnets — see docs/adr/0003-public-subnets-no-nat.md. */
  publicSubnetIds: string[];
}

export interface HarnessStackProps extends StackProps {
  costReportsTable: dynamodb.Table;
  controlTable: dynamodb.Table;
  analysisCacheTable: dynamodb.Table;
  agentSessionsTable: dynamodb.Table;
  configBucket: s3.Bucket;
  evidenceBucket: s3.Bucket;
  sessionBucket: s3.Bucket;
  investigationQueue: sqs.Queue;
  slackSecret: secretsmanager.Secret;
  modelSecret: secretsmanager.Secret;
  litellmSecret: secretsmanager.Secret;
  harnessConfig: HarnessConfigValues;
  network: NetworkConfigValues;
}

export class HarnessStack extends cdk.Stack {
  readonly stateMachineArn: string;
  constructor(scope: Construct, id: string, props: HarnessStackProps) {
    super(scope, id, props);
    tags(this, props.environment);
    // Deploys into a pre-existing, shared VPC — never a fresh one. Imported
    // by fixed attributes, not Vpc.fromLookup, so no live AWS call is
    // needed at synth time and no shared resource is ever touched. Public,
    // IGW-routed subnets (docs/adr/0003) — the ECS tasks below get a public
    // IP per task instead of a NAT Gateway; inbound is blocked entirely by
    // security groups either way.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'SharedVpc', {
      vpcId: props.network.vpcId,
      availabilityZones: props.network.availabilityZones,
      publicSubnetIds: props.network.publicSubnetIds,
    });
    const cluster = new ecs.Cluster(this, 'AgentCluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const agentLogGroup = new logs.LogGroup(this, 'AgentLogGroup', {
      retention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Standalone LiteLLM gateway service (docs/adr/0002), only provisioned
    // when the harness is actually configured to use it — the direct
    // anthropic/bedrock providers pay nothing for it.
    let litellm:
      | { secret: secretsmanager.Secret; baseUrl: string; workerSecurityGroup: ec2.ISecurityGroup }
      | undefined;
    if (props.harnessConfig.worker.model.provider === 'litellm') {
      if (!props.harnessConfig.worker.model.upstreamBedrockModelId) {
        throw new Error('model.provider "litellm" requires worker.model.upstreamBedrockModelId');
      }
      const workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
        vpc: cluster.vpc,
        description:
          'Ephemeral investigation worker task (docs/adr/0002): only needs egress to the LiteLLM gateway.',
      });
      const liteLlmResult = buildLiteLLMService(this, {
        cluster,
        workerSecurityGroup,
        upstreamBedrockModelId: props.harnessConfig.worker.model.upstreamBedrockModelId,
        litellmSecret: props.litellmSecret,
        // Dedicated namespace so this doesn't collide with any shared
        // private DNS namespace already on this VPC owned by another stack.
        cloudMapNamespaceName: `cost-agent-${props.environment}.local`,
      });
      litellm = {
        secret: props.litellmSecret,
        baseUrl: liteLlmResult.baseUrl,
        workerSecurityGroup,
      };
    }

    const { stateMachine, taskDefinition } = buildHarnessStateMachine(this, {
      environment: props.environment,
      costReportsTable: props.costReportsTable,
      controlTable: props.controlTable,
      analysisCacheTable: props.analysisCacheTable,
      agentSessionsTable: props.agentSessionsTable,
      configBucket: props.configBucket,
      evidenceBucket: props.evidenceBucket,
      sessionBucket: props.sessionBucket,
      slackSecret: props.slackSecret,
      modelSecret: props.modelSecret,
      cluster,
      agentLogGroup,
      investigationQueue: props.investigationQueue,
      config: props.harnessConfig,
      ...(litellm ? { litellm } : {}),
    });

    this.stateMachineArn = stateMachine.stateMachineArn;
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
  }
}

export class IntegrationStack extends cdk.Stack {
  readonly slackSecret: secretsmanager.Secret;
  readonly slackSigningSecret: secretsmanager.Secret;
  readonly modelSecret: secretsmanager.Secret;
  readonly litellmSecret: secretsmanager.Secret;
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    tags(this, props.environment);
    this.slackSecret = new secretsmanager.Secret(this, 'SlackSecret', {
      secretName: `CostAgent-${props.environment}-slack`,
      description:
        'Inject the dedicated cost-agent Slack bot token out of band (see docs/adr/0001).',
    });
    this.slackSigningSecret = new secretsmanager.Secret(this, 'SlackSigningSecret', {
      secretName: `CostAgent-${props.environment}-slack-signing`,
      description:
        'Inject the Slack app signing secret out of band (verifies inbound Events API requests).',
    });
    this.modelSecret = new secretsmanager.Secret(this, 'ModelSecret', {
      secretName: `CostAgent-${props.environment}-model`,
      description: 'Inject model provider credentials out of band.',
    });
    // Dedicated, separate from ModelSecret: authenticates to the LiteLLM
    // gateway (docs/adr/0002), not to api.anthropic.com or Bedrock directly.
    // Only read when model.provider is litellm.
    this.litellmSecret = new secretsmanager.Secret(this, 'LiteLLMSecret', {
      secretName: `CostAgent-${props.environment}-litellm`,
      description:
        'Inject the LiteLLM gateway master/virtual key out of band (docs/adr/0002). Only read when model.provider is litellm.',
    });
  }
}

export interface MonitoringStackProps extends StackProps {
  investigationDlq: sqs.Queue;
  stateMachineArn: string;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    tags(this, props.environment);
    const topic = new sns.Topic(this, 'AgentAlerts');

    new cloudwatch.Alarm(this, 'InvestigationDlqDepthAlarm', {
      metric: props.investigationDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'One or more investigation messages exhausted their SQS retries.',
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic));

    new cloudwatch.Alarm(this, 'SupervisorExecutionsFailedAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/States',
        metricName: 'ExecutionsFailed',
        dimensionsMap: { StateMachineArn: props.stateMachineArn },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'The outer supervisor state machine failed an execution.',
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic));

    const widget = new cloudwatch.TextWidget({
      markdown: '# Cost Investigation Agent\nMetrics will be attached by service components.',
      width: 24,
      height: 4,
    }) as unknown as cloudwatch.IWidget;
    new cloudwatch.Dashboard(this, 'AgentDashboard', {
      dashboardName: `${id}-Dashboard`,
      widgets: [[widget]],
    });
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: topic.topicArn });
  }
}

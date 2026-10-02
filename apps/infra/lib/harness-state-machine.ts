import {
  Duration,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_lambda_event_sources as lambdaEventSources,
  aws_logs as logs,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from 'aws-cdk-lib';
import type {
  aws_dynamodb as dynamodb,
  aws_ecs as ecsTypes,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { createNodeFunction } from './node-function.js';
import {
  bedrockModelInvokeStatement,
  costExplorerReadOnlyPolicyStatements,
  crossAccountAssumeRoleStatement,
  exactSecretReadStatement,
  guardDutyAgentEcrPullStatements,
} from './iam-policies.js';

/** Passed to the worker container as one `HARNESS_CONFIG_JSON` env var, rather than dozens of individually-wired variables. */
export interface WorkerStaticConfig {
  model: {
    provider: 'mock' | 'anthropic' | 'bedrock' | 'litellm';
    modelId: string | null;
    gatewayModelName: string | null;
    upstreamBedrockModelId: string | null;
    effort: string;
    temperature: number;
  };
  investigation: {
    maxTurns: number;
    maxBudgetUsd: number;
    maxDurationSeconds: number;
    maxToolCalls: number;
    maxConsecutiveToolErrors: number;
    maxRepeatedEquivalentToolCalls: number;
    maxResultCharacters: number;
  };
  tokens: {
    maxCumulativeInputTokens: number;
    maxCumulativeOutputTokens: number;
    maxFinalOutputTokens: number;
  };
  evidence: {
    minimumConfidenceForLikelyDriverIdentified: number;
    minimumEvidenceTypesForLikelyDriverIdentified: number;
  };
  enabledMcpTools: string[];
  promptVersion: string;
}

export interface HarnessConfigValues {
  lockTtlSeconds: number;
  concurrency: { maxGlobalInvestigations: number; maxPerReportInvestigations: number };
  memory: { retentionSeconds: number };
  significantChangePercent: number;
  fargate: { cpu: number; memoryMiB: number; taskTimeoutSeconds: number };
  /** Linked accounts describe_resources may touch — the worker's IAM boundary AND the tool policy's allowlist, from harness.yaml's environment allowlist. */
  allowedAccountIds: string[];
  crossAccountRoleName?: string;
  slack: { enabled: boolean; channelId: string };
  /** `<repository>@sha256:<digest>` or `<repository>:<tag>` from a separate build/push pipeline; omitted falls back to a local asset build. */
  agentWorkerImageUri?: string;
  worker: WorkerStaticConfig;
}

export interface HarnessStateMachineProps {
  environment: string;
  costReportsTable: dynamodb.Table;
  controlTable: dynamodb.Table;
  analysisCacheTable: dynamodb.Table;
  agentSessionsTable: dynamodb.Table;
  configBucket: s3.Bucket;
  evidenceBucket: s3.Bucket;
  sessionBucket: s3.Bucket;
  slackSecret: secretsmanager.Secret;
  modelSecret: secretsmanager.Secret;
  cluster: ecs.Cluster;
  agentLogGroup: logs.LogGroup;
  investigationQueue: sqs.Queue;
  config: HarnessConfigValues;
  /** Only present when config.worker.model.provider === 'litellm' (docs/adr/0002). */
  litellm?: {
    secret: secretsmanager.Secret;
    /** Cloud Map DNS base URL of the gateway service, e.g. http://litellm.cost-agent-dev.local:4000 */
    baseUrl: string;
    /** Attached to the worker task so the LiteLLM service's security group can allow ingress from it by reference. */
    workerSecurityGroup: ec2.ISecurityGroup;
  };
}

export interface HarnessStateMachineResult {
  stateMachine: sfn.StateMachine;
  taskDefinition: ecs.FargateTaskDefinition;
  dispatchFunction: lambda.Function;
}

const AGENT_CONTAINER_NAME = 'AgentWorker';

export function buildHarnessStateMachine(
  scope: Construct,
  props: HarnessStateMachineProps,
): HarnessStateMachineResult {
  const commonTableNames = {
    COST_REPORTS_TABLE: props.costReportsTable.tableName,
    CONTROL_TABLE: props.controlTable.tableName,
    ANALYSIS_CACHE_TABLE: props.analysisCacheTable.tableName,
  };

  // --- ECS worker task ---
  const executionRole = new iam.Role(scope, 'AgentExecutionRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });
  for (const statement of guardDutyAgentEcrPullStatements(scope))
    executionRole.addToPolicy(statement);

  const taskRole = new iam.Role(scope, 'AgentTaskRole', {
    // Explicit, predictable name (not CDK's auto-generated one) so the
    // cross-account read-only role's trust policy (provisioned out of band
    // in PACO-Production/PACO-Non-Production — see
    // cross-account-role/README.md) can reference this exact ARN instead of
    // trusting the whole management account.
    roleName: `CostAgent-${props.environment}-worker-task-role`,
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });
  for (const statement of costExplorerReadOnlyPolicyStatements()) taskRole.addToPolicy(statement);
  const workerSecretArns = [props.modelSecret.secretArn];
  if (props.config.worker.model.provider === 'litellm') {
    if (!props.litellm) throw new Error('LITELLM_PROPS_REQUIRED_FOR_LITELLM_PROVIDER');
    workerSecretArns.push(props.litellm.secret.secretArn);
  }
  taskRole.addToPolicy(exactSecretReadStatement(workerSecretArns));
  // Direct Bedrock IAM access is granted here only for the `bedrock`
  // provider. In `litellm` mode the worker never calls Bedrock itself —
  // that grant instead lives on the LiteLLM gateway service's own task
  // role (litellm-service.ts), per docs/adr/0001/0002 isolation.
  if (props.config.worker.model.provider === 'bedrock') {
    if (!props.config.worker.model.modelId)
      throw new Error('Bedrock requires an explicit model ID');
    taskRole.addToPolicy(bedrockModelInvokeStatement(scope, props.config.worker.model.modelId));
  }
  const crossAccountRoleName = props.config.crossAccountRoleName;
  if (crossAccountRoleName) {
    const roleArns = props.config.allowedAccountIds.map(
      (accountId) => `arn:aws:iam::${accountId}:role/${crossAccountRoleName}`,
    );
    if (roleArns.length > 0) taskRole.addToPolicy(crossAccountAssumeRoleStatement(roleArns));
  }
  props.evidenceBucket.grantReadWrite(taskRole);
  props.sessionBucket.grantReadWrite(taskRole);
  props.configBucket.grantRead(taskRole);
  props.agentSessionsTable.grantReadWriteData(taskRole);
  // Read-only: get_report/get_prior_reports query CostReportsTable. The
  // worker never writes it — persist-result and the Slack handler own that.
  props.costReportsTable.grantReadData(taskRole);
  // Read-only: the worker reads its own prior analysis for this exact line
  // (if any) as context for the current investigation. persist-result owns
  // the write after this run completes.
  props.analysisCacheTable.grantReadData(taskRole);

  const taskDefinition = new ecs.FargateTaskDefinition(scope, 'AgentTaskDefinition', {
    cpu: props.config.fargate.cpu,
    memoryLimitMiB: props.config.fargate.memoryMiB,
    executionRole,
    taskRole,
  });
  const agentContainer = taskDefinition.addContainer(AGENT_CONTAINER_NAME, {
    image: props.config.agentWorkerImageUri
      ? ecs.ContainerImage.fromRegistry(props.config.agentWorkerImageUri)
      : ecs.ContainerImage.fromAsset(process.cwd(), {
          file: 'apps/agent-worker/Dockerfile',
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
    logging: ecs.LogDrivers.awsLogs({ logGroup: props.agentLogGroup, streamPrefix: 'agent' }),
    environment: {
      ...commonTableNames,
      AGENT_SESSIONS_TABLE: props.agentSessionsTable.tableName,
      EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
      SESSION_BUCKET: props.sessionBucket.bucketName,
      CONFIG_BUCKET: props.configBucket.bucketName,
      MODEL_SECRET_ARN: props.modelSecret.secretArn,
      HARNESS_CONFIG_JSON: JSON.stringify(props.config.worker),
      ALLOWED_ACCOUNT_IDS_JSON: JSON.stringify(props.config.allowedAccountIds),
      ...(props.config.crossAccountRoleName
        ? { CROSS_ACCOUNT_ROLE_NAME: props.config.crossAccountRoleName }
        : {}),
      ...(props.litellm
        ? {
            LITELLM_SECRET_ARN: props.litellm.secret.secretArn,
            LITELLM_BASE_URL: props.litellm.baseUrl,
          }
        : {}),
    },
  });

  // --- Lambda functions backing the outer supervisor ---
  const resolveContextFn = createNodeFunction(scope, 'ResolveContextFunction', {
    functionName: `CostAgent-${props.environment}-resolve-context`,
    entry: 'apps/functions/resolve-context/index.ts',
    environment: { ...commonTableNames, CONFIG_BUCKET: props.configBucket.bucketName },
  });
  props.costReportsTable.grantReadData(resolveContextFn);
  props.configBucket.grantRead(resolveContextFn);

  const validateAnalysisFn = createNodeFunction(scope, 'ValidateAnalysisFunction', {
    functionName: `CostAgent-${props.environment}-validate-analysis`,
    entry: 'apps/functions/validate-analysis/index.ts',
    environment: {
      EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
      MINIMUM_CONFIDENCE_FOR_LIKELY_DRIVER_IDENTIFIED: String(
        props.config.worker.evidence.minimumConfidenceForLikelyDriverIdentified,
      ),
      MINIMUM_EVIDENCE_TYPES_FOR_LIKELY_DRIVER_IDENTIFIED: String(
        props.config.worker.evidence.minimumEvidenceTypesForLikelyDriverIdentified,
      ),
    },
  });
  props.evidenceBucket.grantRead(validateAnalysisFn);

  const persistResultFn = createNodeFunction(scope, 'PersistResultFunction', {
    functionName: `CostAgent-${props.environment}-persist-result`,
    entry: 'apps/functions/persist-result/index.ts',
    environment: {
      ...commonTableNames,
      MEMORY_RETENTION_SECONDS: String(props.config.memory.retentionSeconds),
    },
  });
  props.costReportsTable.grantReadWriteData(persistResultFn);
  props.analysisCacheTable.grantReadWriteData(persistResultFn);
  props.controlTable.grantReadWriteData(persistResultFn);

  const notifySlackFn = createNodeFunction(scope, 'NotifySlackFunction', {
    functionName: `CostAgent-${props.environment}-notify-slack`,
    entry: 'apps/functions/notify-slack/index.ts',
    environment: {
      CONTROL_TABLE: props.controlTable.tableName,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      SLACK_CHANNEL_ID: props.config.slack.channelId,
      ANALYSIS_CACHE_TABLE: props.analysisCacheTable.tableName,
    },
  });
  props.controlTable.grantReadWriteData(notifySlackFn);
  // Read-only: the report_complete message re-reads each completed line's
  // validated analysis back from where persist-result already wrote it,
  // rather than threading the full FinalCostAnalysis through the fan-in
  // batch item itself.
  props.analysisCacheTable.grantReadData(notifySlackFn);
  notifySlackFn.addToRolePolicy(exactSecretReadStatement([props.slackSecret.secretArn]));

  const handleFailureFn = createNodeFunction(scope, 'HandleFailureFunction', {
    functionName: `CostAgent-${props.environment}-handle-failure`,
    entry: 'apps/functions/handle-failure/index.ts',
    environment: commonTableNames,
  });
  props.costReportsTable.grantReadWriteData(handleFailureFn);
  props.controlTable.grantReadWriteData(handleFailureFn);

  // --- ASL; every task Catches to a HandleFailure invocation ---
  const invoke = (id: string, fn: lambda.Function, payload: sfn.TaskInput, resultPath: string) =>
    new tasks.LambdaInvoke(scope, id, {
      lambdaFunction: fn,
      payload,
      payloadResponseOnly: true,
      resultPath,
    });

  const failWorkflowError = invoke(
    'HandleWorkflowError',
    handleFailureFn,
    sfn.TaskInput.fromObject({
      reportDate: sfn.JsonPath.stringAt('$.reportDate'),
      lineFingerprint: sfn.JsonPath.stringAt('$.lineFingerprint'),
      lineLabel: sfn.JsonPath.stringAt('$.lineLabel'),
      ownerToken: sfn.JsonPath.stringAt('$.ownerToken'),
      batchId: sfn.JsonPath.stringAt('$.batchId'),
      expectedCount: sfn.JsonPath.numberAt('$.expectedCount'),
      trendDirection: sfn.JsonPath.stringAt('$.trendDirection'),
      reason: 'WORKFLOW_ERROR',
      errorMessage: sfn.JsonPath.stringAt('$.error.Cause'),
    }),
    '$.completion',
  );

  const resolveContext = invoke(
    'ResolveContext',
    resolveContextFn,
    sfn.TaskInput.fromObject({
      reportDate: sfn.JsonPath.stringAt('$.reportDate'),
      lineFingerprint: sfn.JsonPath.stringAt('$.lineFingerprint'),
      ownerToken: sfn.JsonPath.stringAt('$.ownerToken'),
    }),
    '$.resolve',
  ).addCatch(failWorkflowError, { resultPath: '$.error' });

  const failMissingReport = invoke(
    'HandleMissingReport',
    handleFailureFn,
    sfn.TaskInput.fromObject({
      reportDate: sfn.JsonPath.stringAt('$.reportDate'),
      lineFingerprint: sfn.JsonPath.stringAt('$.lineFingerprint'),
      lineLabel: sfn.JsonPath.stringAt('$.lineLabel'),
      ownerToken: sfn.JsonPath.stringAt('$.ownerToken'),
      batchId: sfn.JsonPath.stringAt('$.batchId'),
      expectedCount: sfn.JsonPath.numberAt('$.expectedCount'),
      trendDirection: sfn.JsonPath.stringAt('$.trendDirection'),
      reason: sfn.JsonPath.stringAt('$.resolve.outcome'),
    }),
    '$.completion',
  );

  const resultKeyPath = sfn.JsonPath.format(
    'worker-results/{}.json',
    sfn.JsonPath.stringAt('$.ownerToken'),
  );

  const runAgentWorkerOnEcs = new tasks.EcsRunTask(scope, 'RunAgentWorkerOnECS', {
    integrationPattern: sfn.IntegrationPattern.RUN_JOB,
    taskTimeout: sfn.Timeout.duration(Duration.seconds(props.config.fargate.taskTimeoutSeconds)),
    cluster: props.cluster as ecsTypes.ICluster,
    taskDefinition,
    launchTarget: new tasks.EcsFargateLaunchTarget(),
    // Public, IGW-routed subnets — no NAT Gateway (docs/adr/0003). Inbound
    // stays fully blocked by the security group regardless of the task
    // having a public IP; nothing in this security group ever allows
    // inbound from 0.0.0.0/0.
    subnets: { subnetType: ec2.SubnetType.PUBLIC },
    assignPublicIp: true,
    // Explicit only in litellm mode, so the LiteLLM service's security
    // group can allow ingress on 4000 from exactly this group
    // (litellm-service.ts). Omitted otherwise, matching the default
    // security-group behavior.
    ...(props.litellm ? { securityGroups: [props.litellm.workerSecurityGroup] } : {}),
    resultPath: '$.ecsResult',
    containerOverrides: [
      {
        containerDefinition: agentContainer,
        environment: [
          { name: 'REPORT_DATE', value: sfn.JsonPath.stringAt('$.reportDate') },
          { name: 'LINE_FINGERPRINT', value: sfn.JsonPath.stringAt('$.lineFingerprint') },
          {
            name: 'LINE_JSON',
            value: sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$.resolve.line')),
          },
          { name: 'OWNER_TOKEN', value: sfn.JsonPath.stringAt('$.ownerToken') },
          { name: 'PLAYBOOK', value: sfn.JsonPath.stringAt('$.resolve.playbook') },
          { name: 'RESULT_KEY', value: resultKeyPath },
          { name: 'EXECUTION_ID', value: sfn.JsonPath.stringAt('$$.Execution.Id') },
        ],
      },
    ],
  }).addCatch(failWorkflowError, { resultPath: '$.error' });

  const validateFinalAnalysis = invoke(
    'ValidateFinalAnalysis',
    validateAnalysisFn,
    sfn.TaskInput.fromObject({
      reportDate: sfn.JsonPath.stringAt('$.reportDate'),
      lineFingerprint: sfn.JsonPath.stringAt('$.lineFingerprint'),
      ownerToken: sfn.JsonPath.stringAt('$.ownerToken'),
      resultKey: resultKeyPath,
    }),
    '$.validated',
  ).addCatch(failWorkflowError, { resultPath: '$.error' });

  const failMissingResult = invoke(
    'HandleMissingWorkerResult',
    handleFailureFn,
    sfn.TaskInput.fromObject({
      reportDate: sfn.JsonPath.stringAt('$.reportDate'),
      lineFingerprint: sfn.JsonPath.stringAt('$.lineFingerprint'),
      lineLabel: sfn.JsonPath.stringAt('$.lineLabel'),
      ownerToken: sfn.JsonPath.stringAt('$.ownerToken'),
      batchId: sfn.JsonPath.stringAt('$.batchId'),
      expectedCount: sfn.JsonPath.numberAt('$.expectedCount'),
      trendDirection: sfn.JsonPath.stringAt('$.trendDirection'),
      reason: 'MISSING_WORKER_RESULT',
    }),
    '$.completion',
  );

  const persistAnalysis = invoke(
    'PersistAnalysis',
    persistResultFn,
    sfn.TaskInput.fromObject({
      reportDate: sfn.JsonPath.stringAt('$.reportDate'),
      lineFingerprint: sfn.JsonPath.stringAt('$.lineFingerprint'),
      lineLabel: sfn.JsonPath.stringAt('$.lineLabel'),
      ownerToken: sfn.JsonPath.stringAt('$.ownerToken'),
      batchId: sfn.JsonPath.stringAt('$.batchId'),
      expectedCount: sfn.JsonPath.numberAt('$.expectedCount'),
      trendDirection: sfn.JsonPath.stringAt('$.trendDirection'),
      analysis: sfn.JsonPath.objectAt('$.validated.validation.analysis'),
    }),
    '$.completion',
  ).addCatch(failWorkflowError, { resultPath: '$.error' });

  // Gate the one consolidated Slack message behind "am I the last of this
  // report round's N parallel per-line executions to finish" — every
  // terminal Lambda (persist-result on success, handle-failure on any
  // failure) contributes to the same DynamoDB batch item and reports back
  // via `$.completion.batchComplete`; only the winner's execution reaches
  // this Choice with `true`. Builds a fresh NotifyReportComplete construct
  // per call site (CDK construct IDs — and ASL states — must be unique, and
  // each of the 5 terminal branches below needs its own `Next` target after
  // notifying, so this can't be one shared invoke reused across all of them).
  function buildNotifyReportComplete(id: string): tasks.LambdaInvoke | sfn.Pass {
    return props.config.slack.enabled
      ? invoke(
          `${id}NotifyReportComplete`,
          notifySlackFn,
          sfn.TaskInput.fromObject({
            kind: 'report_complete',
            reportDate: sfn.JsonPath.stringAt('$.reportDate'),
            lines: sfn.JsonPath.listAt('$.completion.batch.lines'),
          }),
          '$.notifyComplete',
        )
      : new sfn.Pass(scope, `${id}SlackReportCompleteDisabled`);
  }

  function finishExecution(id: string, terminal: sfn.IChainable): sfn.Chain {
    return sfn.Chain.start(
      new sfn.Choice(scope, `${id}BranchOnBatchCompletion`)
        .when(
          sfn.Condition.booleanEquals('$.completion.batchComplete', true),
          buildNotifyReportComplete(id).next(terminal),
        )
        .otherwise(terminal),
    );
  }

  const workflowFailed = new sfn.Fail(scope, 'WorkflowFailed');
  const missingReportDeferred = new sfn.Succeed(scope, 'MissingReportDeferred');
  const missingWorkerResultDeferred = new sfn.Succeed(scope, 'MissingWorkerResultDeferred');
  const investigationComplete = new sfn.Succeed(scope, 'InvestigationComplete');

  const validationChoice = new sfn.Choice(scope, 'BranchOnValidationOutcome')
    .when(
      sfn.Condition.stringEquals('$.validated.outcome', 'MISSING_RESULT'),
      failMissingResult.next(finishExecution('MissingWorkerResult', missingWorkerResultDeferred)),
    )
    .otherwise(persistAnalysis.next(finishExecution('Success', investigationComplete)));

  // Both REPORT_NOT_FOUND and LINE_NOT_FOUND route through the exact same
  // failMissingReport state — a single shared construct can only carry one
  // `.next()` transition in ASL, so it's set once here and both Choice
  // branches below reference the same object, converging as they always did.
  failMissingReport.next(finishExecution('MissingReport', missingReportDeferred));

  const contextChoice = new sfn.Choice(scope, 'BranchOnResolveOutcome')
    .when(sfn.Condition.stringEquals('$.resolve.outcome', 'REPORT_NOT_FOUND'), failMissingReport)
    .when(sfn.Condition.stringEquals('$.resolve.outcome', 'LINE_NOT_FOUND'), failMissingReport)
    .otherwise(runAgentWorkerOnEcs.next(validateFinalAnalysis).next(validationChoice));

  failWorkflowError.next(finishExecution('WorkflowError', workflowFailed));

  const definition = resolveContext.next(contextChoice);

  const stateMachineLogGroup = new logs.LogGroup(scope, 'SupervisorLogGroup', {
    retention: logs.RetentionDays.ONE_MONTH,
  });
  const stateMachine = new sfn.StateMachine(scope, 'Supervisor', {
    stateMachineType: sfn.StateMachineType.STANDARD,
    definitionBody: sfn.DefinitionBody.fromChainable(definition),
    timeout: Duration.seconds(props.config.fargate.taskTimeoutSeconds + 120),
    logs: {
      destination: stateMachineLogGroup,
      level: sfn.LogLevel.ERROR,
      includeExecutionData: false,
    },
  });
  stateMachine.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecs:StopTask'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }),
  );

  // --- Dispatcher: consumes Investigation SQS, starts the supervisor execution ---
  const dispatchFunction = createNodeFunction(scope, 'DispatchFunction', {
    functionName: `CostAgent-${props.environment}-dispatch`,
    entry: 'apps/functions/dispatch/index.ts',
    environment: { STATE_MACHINE_ARN: stateMachine.stateMachineArn },
  });
  stateMachine.grantStartExecution(dispatchFunction);
  dispatchFunction.addEventSource(
    new lambdaEventSources.SqsEventSource(props.investigationQueue, { batchSize: 1 }),
  );

  return { stateMachine, taskDefinition, dispatchFunction };
}

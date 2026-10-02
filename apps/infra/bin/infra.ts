import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { loadHarnessConfig } from '../../../packages/config/src/index.js';
import {
  ConfigStack,
  DataStack,
  HarnessStack,
  IngestionStack,
  IntegrationStack,
  MonitoringStack,
} from '../lib/stacks.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const app = new cdk.App();
const rawEnvironment = app.node.tryGetContext('environment') as unknown;
const environment = typeof rawEnvironment === 'string' ? rawEnvironment : 'dev';
const rawAccount = app.node.tryGetContext('account') as unknown;
const rawRegion = app.node.tryGetContext('region') as unknown;
const account = typeof rawAccount === 'string' ? rawAccount : undefined;
const region = typeof rawRegion === 'string' ? rawRegion : undefined;
const rawAgentWorkerImage = app.node.tryGetContext('agentWorkerImage') as unknown;
const agentWorkerImageUri =
  typeof rawAgentWorkerImage === 'string' ? rawAgentWorkerImage : undefined;

// Fail closed, two independent gates (COST_AGENT_BUILD_SPEC.md). Selecting
// `staging`/`prod` here grants no access by itself:
// 1. `--context account=/region=` must be supplied on the CLI for this synth.
// 2. `loadHarnessConfig` separately throws unless that same environment's
//    harness.yaml block has its own target account/region/confirmation and
//    non-empty allowlists explicitly populated.
if (environment !== 'dev' && (!account || !region)) {
  throw new Error(
    `Explicit --context account=<id> region=<region> is required to synth/deploy the ${environment} environment.`,
  );
}
const harnessConfig = await loadHarnessConfig(
  path.join(repoRoot, 'config/harness.yaml'),
  environment,
);
const environmentSafety = harnessConfig.environments[environment as 'dev' | 'staging' | 'prod'];

const env = account && region ? { account, region } : undefined;
const prefix = `CostAgent-${environment}`;

class Foundation extends Construct {
  readonly config: ConfigStack;
  readonly data: DataStack;
  readonly ingestion: IngestionStack;
  readonly integration: IntegrationStack;
  readonly harness: HarnessStack;
  readonly monitoring: MonitoringStack;

  constructor(scope: Construct) {
    super(scope, 'Foundation');
    const props = env ? { env, environment } : { environment };

    this.config = new ConfigStack(scope, `${prefix}-Config`, props);
    this.data = new DataStack(scope, `${prefix}-Data`, props);
    this.integration = new IntegrationStack(scope, `${prefix}-Integration`, props);

    this.ingestion = new IngestionStack(scope, `${prefix}-Ingestion`, {
      ...props,
      costReportsTable: this.data.costReports,
      controlTable: this.data.control,
      analysisCacheTable: this.data.analysisCache,
      configBucket: this.config.bucket,
      lockTtlSeconds: harnessConfig.locks.ttlSeconds,
      // A batch must outlive the slowest of a report round's N parallel
      // per-line investigations, not just one line's lock — bound it to the
      // ECS task timeout (plus headroom for the surrounding
      // resolve-context/validate-analysis/persist-result Lambda hops) rather
      // than reusing the lock TTL verbatim.
      batchTtlSeconds: Math.max(
        harnessConfig.locks.ttlSeconds,
        harnessConfig.fargate.taskTimeoutSeconds + 300,
      ),
      concurrency: harnessConfig.concurrency,
      significantChangePercent: harnessConfig.significance.significantChangePercent,
      excludedLabels: harnessConfig.significance.excludedLabels,
      slackSecret: this.integration.slackSecret,
      slackSigningSecret: this.integration.slackSigningSecret,
    });

    if (!environmentSafety.network) {
      throw new Error(
        `environments.${environment}.network is required to deploy the Harness stack (no VPC assigned)`,
      );
    }

    this.harness = new HarnessStack(scope, `${prefix}-Harness`, {
      ...props,
      network: environmentSafety.network,
      costReportsTable: this.data.costReports,
      controlTable: this.data.control,
      analysisCacheTable: this.data.analysisCache,
      agentSessionsTable: this.data.sessions,
      configBucket: this.config.bucket,
      evidenceBucket: this.data.evidenceBucket,
      sessionBucket: this.data.sessionBucket,
      investigationQueue: this.ingestion.queue,
      slackSecret: this.integration.slackSecret,
      modelSecret: this.integration.modelSecret,
      litellmSecret: this.integration.litellmSecret,
      harnessConfig: {
        lockTtlSeconds: harnessConfig.locks.ttlSeconds,
        concurrency: harnessConfig.concurrency,
        memory: { retentionSeconds: harnessConfig.memory.retentionSeconds },
        significantChangePercent: harnessConfig.significance.significantChangePercent,
        fargate: {
          cpu: harnessConfig.fargate.cpu,
          memoryMiB: harnessConfig.fargate.memoryMiB,
          taskTimeoutSeconds: harnessConfig.fargate.taskTimeoutSeconds,
        },
        allowedAccountIds: environmentSafety.allowlists.awsAccounts,
        ...(environmentSafety.crossAccountRoleName
          ? { crossAccountRoleName: environmentSafety.crossAccountRoleName }
          : {}),
        slack: {
          enabled: environmentSafety.slack.enabled,
          channelId: environmentSafety.slack.channelId ?? 'unset-channel',
        },
        ...(agentWorkerImageUri ? { agentWorkerImageUri } : {}),
        worker: {
          model: {
            provider: harnessConfig.model.provider,
            modelId: harnessConfig.model.modelId,
            gatewayModelName: harnessConfig.model.gatewayModelName,
            upstreamBedrockModelId: harnessConfig.model.upstreamBedrockModelId,
            effort: harnessConfig.model.effort,
            temperature: harnessConfig.model.temperature,
          },
          investigation: {
            maxTurns: harnessConfig.investigation.maxTurns,
            maxBudgetUsd: harnessConfig.investigation.maxBudgetUsd,
            maxDurationSeconds: harnessConfig.investigation.maxDurationSeconds,
            maxToolCalls: harnessConfig.investigation.maxToolCalls,
            maxConsecutiveToolErrors: harnessConfig.investigation.maxConsecutiveToolErrors,
            maxRepeatedEquivalentToolCalls:
              harnessConfig.investigation.maxRepeatedEquivalentToolCalls,
            maxResultCharacters: harnessConfig.investigation.maxResultCharacters,
          },
          tokens: {
            maxCumulativeInputTokens: harnessConfig.tokens.maxCumulativeInputTokens,
            maxCumulativeOutputTokens: harnessConfig.tokens.maxCumulativeOutputTokens,
            maxFinalOutputTokens: harnessConfig.tokens.maxFinalOutputTokens,
          },
          evidence: {
            minimumConfidenceForLikelyDriverIdentified:
              harnessConfig.evidence.minimumConfidenceForLikelyDriverIdentified,
            minimumEvidenceTypesForLikelyDriverIdentified:
              harnessConfig.evidence.minimumEvidenceTypesForLikelyDriverIdentified,
          },
          enabledMcpTools: harnessConfig.agentSdk.enabledMcpTools,
          promptVersion: harnessConfig.model.promptVersion,
        },
      },
    });

    this.monitoring = new MonitoringStack(scope, `${prefix}-Monitoring`, {
      ...props,
      investigationDlq: this.ingestion.deadLetterQueue,
      stateMachineArn: this.harness.stateMachineArn,
    });
  }
}

new Foundation(app);

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';

import {
  DynamoRepositories,
  CachedSecretReader,
  S3EvidenceCatalog,
  S3WorkerResultStore,
  readYamlFromS3,
} from '../../../packages/aws-repositories/src/index.js';
import {
  CostExplorerConnector,
  ResourceDescribeConnector,
  PriorReportsConnector,
  CloudWatchConnector,
  CloudTrailConnector,
  buildComposedCostConnector,
  buildCrossAccountClientFactory,
} from '../../../packages/cost-connectors/src/index.js';
import {
  DynamoDbSessionMetadataStore,
  DynamoDbCostSessionMapping,
  CostMappedSessionStore,
  S3ExternalSessionStore,
} from '../../../packages/session-store/src/index.js';
import { PlaybooksConfigSchema, type PlaybooksConfig } from '../../../packages/config/src/index.js';
import type { BudgetUsage } from '../../../packages/core/src/index.js';
import { buildHarnessHooks } from '../../../packages/agent-sdk-runtime/src/hooks.js';
import { buildAgentRuntimeOptions } from '../../../packages/agent-sdk-runtime/src/sdk-contract.js';
import { buildCostGoal } from '../../../packages/agent-sdk-runtime/src/prompt.js';
import {
  buildCostToolServer,
  type ToolServerDependencies,
} from '../../../packages/agent-sdk-runtime/src/tool-server.js';
import {
  resolveResumeSessionId,
  withResume,
} from '../../../packages/agent-sdk-runtime/src/resume.js';
import { runWorker } from '../../../packages/agent-sdk-runtime/src/worker.js';
import type {
  CostClassification,
  CostEvidenceRecord,
  CostReportLine,
  FinalCostAnalysis,
} from '../../../packages/schemas/src/index.js';

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

interface WorkerStaticConfig {
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

// Every investigation submits its answer through this tool
// (packages/agent-sdk-runtime/src/tool-server.ts), regardless of playbook.
const FINAL_ANSWER_TOOL_NAME = 'mcp__cost__submit_final_analysis';

const AnthropicModelSecretSchema = z.object({ apiKey: z.string().min(1) }).strict();
// The LiteLLM virtual/master key, sent as ANTHROPIC_AUTH_TOKEN so Claude
// Code authenticates to the gateway the same way it would to api.anthropic.com.
const LiteLLMSecretSchema = z.object({ apiKey: z.string().min(1) }).strict();

async function buildModelEnvironment(
  config: WorkerStaticConfig,
  secrets: CachedSecretReader,
): Promise<Record<string, string>> {
  // litellm mode identifies the model via gatewayModelName (LiteLLM's own
  // model_name), not modelId, which config/harness.yaml leaves null for it.
  if (config.model.provider === 'litellm') {
    if (!config.model.gatewayModelName) throw new Error('GATEWAY_MODEL_NAME_NOT_CONFIGURED');
  } else if (config.model.provider !== 'bedrock' && !config.model.modelId) {
    throw new Error('MODEL_ID_NOT_CONFIGURED');
  }
  if (config.model.provider === 'anthropic') {
    const secret = AnthropicModelSecretSchema.parse(
      JSON.parse(await secrets.getSecretString(mustEnv('MODEL_SECRET_ARN'))) as unknown,
    );
    return { ANTHROPIC_API_KEY: secret.apiKey };
  }
  if (config.model.provider === 'bedrock') {
    return { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: mustEnv('AWS_REGION') };
  }
  if (config.model.provider === 'litellm') {
    // Separate secret from the direct-Anthropic MODEL_SECRET_ARN: this key
    // authenticates to the LiteLLM gateway, not to api.anthropic.com, and
    // the worker task role only ever gets exact-ARN read access to it —
    // never the Bedrock credentials the gateway itself holds.
    const secret = LiteLLMSecretSchema.parse(
      JSON.parse(await secrets.getSecretString(mustEnv('LITELLM_SECRET_ARN'))) as unknown,
    );
    return { ANTHROPIC_BASE_URL: mustEnv('LITELLM_BASE_URL'), ANTHROPIC_AUTH_TOKEN: secret.apiKey };
  }
  throw new Error('MODEL_PROVIDER_NOT_CONFIGURED');
}

async function main(): Promise<void> {
  const config = JSON.parse(mustEnv('HARNESS_CONFIG_JSON')) as WorkerStaticConfig;

  const reportDate = mustEnv('REPORT_DATE');
  const lineFingerprint = mustEnv('LINE_FINGERPRINT');
  const line = JSON.parse(mustEnv('LINE_JSON')) as CostReportLine;
  const ownerToken = mustEnv('OWNER_TOKEN');
  const playbookName = mustEnv('PLAYBOOK');
  const resultKey = mustEnv('RESULT_KEY');
  const executionId = mustEnv('EXECUTION_ID');
  const allowedAccountIds = JSON.parse(mustEnv('ALLOWED_ACCOUNT_IDS_JSON')) as string[];
  const region = mustEnv('AWS_REGION');

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({});
  const secrets = new CachedSecretReader(new SecretsManagerClient({}));
  const modelEnvironment = await buildModelEnvironment(config, secrets);

  const tables = {
    costReports: mustEnv('COST_REPORTS_TABLE'),
    control: mustEnv('CONTROL_TABLE'),
    analysisCache: mustEnv('ANALYSIS_CACHE_TABLE'),
  };
  const repositories = new DynamoRepositories<FinalCostAnalysis>(ddb, tables);
  const evidenceBucket = mustEnv('EVIDENCE_BUCKET');
  const sessionBucket = mustEnv('SESSION_BUCKET');
  const configBucket = mustEnv('CONFIG_BUCKET');

  const reportRecord = await repositories.getReport(reportDate);
  if (!reportRecord) throw new Error(`COST_REPORT_NOT_FOUND: ${reportDate}`);
  const priorAnalysis = await repositories.getPriorAnalysis(lineFingerprint);

  const playbooksConfig: PlaybooksConfig = PlaybooksConfigSchema.parse(
    await readYamlFromS3(s3, configBucket, 'playbooks.yaml'),
  );
  const playbook = playbooksConfig.playbooks[playbookName];
  if (!playbook) throw new Error(`PLAYBOOK_NOT_FOUND: ${playbookName}`);
  const allowedTools = [...playbook.enabledTools, FINAL_ANSWER_TOOL_NAME];

  const costExplorer = new CostExplorerConnector(new CostExplorerClient({}));
  const crossAccountRoleName = process.env.CROSS_ACCOUNT_ROLE_NAME;
  const crossAccountClientFactory = crossAccountRoleName
    ? buildCrossAccountClientFactory(new STSClient({}), {
        roleName: crossAccountRoleName,
        region,
      })
    : () => Promise.reject(new Error('CROSS_ACCOUNT_ROLE_NOT_CONFIGURED'));
  const resources = new ResourceDescribeConnector(crossAccountClientFactory);
  const priorReports = new PriorReportsConnector(ddb, tables.costReports);
  const cloudwatch = new CloudWatchConnector(crossAccountClientFactory);
  const cloudtrail = new CloudTrailConnector(crossAccountClientFactory);
  const connector = buildComposedCostConnector({
    report: reportRecord.report,
    costExplorer,
    resources,
    priorReports,
    cloudwatch,
    cloudtrail,
  });

  const evidenceCatalog = new S3EvidenceCatalog(s3, evidenceBucket);
  const evidenceCatalogKey = `evidence/${reportDate}/${lineFingerprint}/catalog.json`;
  const collectedEvidence: CostEvidenceRecord[] =
    await evidenceCatalog.loadRecords(evidenceCatalogKey);
  let evidenceSequence = collectedEvidence.length;
  const evidenceWriter = {
    persist: async (input: {
      toolName: string;
      type: CostEvidenceRecord['type'];
      summary: string;
      data: unknown;
      metadata?: Record<string, unknown>;
    }) => {
      evidenceSequence += 1;
      const record = await evidenceCatalog.persist({
        type: input.type,
        summary: input.summary,
        data: input.data,
        collectedAt: new Date().toISOString(),
        storageKey: `evidence/${reportDate}/${lineFingerprint}/${input.toolName}-${String(evidenceSequence)}.json`,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      collectedEvidence.push(record);
      await evidenceCatalog.saveRecords(evidenceCatalogKey, collectedEvidence);
      return record.id;
    },
  };

  const nowIso = new Date().toISOString();
  const policy: ToolServerDependencies['policy'] = {
    reportDate,
    allowedAccountIds,
    // CE/anomaly date windows are bounded to the last 45 days before the
    // report — generous enough for trend/anomaly context, still bounded.
    earliestTime: new Date(
      Date.parse(`${reportDate}T00:00:00Z`) - 45 * 24 * 60 * 60_000,
    ).toISOString(),
    latestTime: nowIso,
    maxResultCharacters: config.investigation.maxResultCharacters,
  };

  const toolServer = buildCostToolServer({
    connector,
    evidenceWriter,
    policy,
    context: { region, costReportsTableName: tables.costReports },
  });

  const sessionMetadataTable = mustEnv('AGENT_SESSIONS_TABLE');
  const durableSessionStore = new DynamoDbSessionMetadataStore(
    new S3ExternalSessionStore(s3, sessionBucket),
    ddb,
    {
      tableName: sessionMetadataTable,
      projectKeyIndexName: 'ByProjectKey',
      ttlSeconds: 30 * 24 * 60 * 60,
    },
  );
  const sessionMapping = new DynamoDbCostSessionMapping(ddb, sessionMetadataTable);
  const resumeSessionId = await resolveResumeSessionId(lineFingerprint, sessionMapping);
  const sessionStore = new CostMappedSessionStore(
    durableSessionStore,
    sessionMapping,
    lineFingerprint,
  );

  const usage: BudgetUsage = {
    startedAtMs: Date.now(),
    turns: 0,
    toolCalls: 0,
    consecutiveToolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  const hooks = buildHarnessHooks({
    reportDate,
    lineFingerprint,
    allowedTools,
    finalAnswerToolName: FINAL_ANSWER_TOOL_NAME,
    limits: {
      maxDurationSeconds: config.investigation.maxDurationSeconds,
      maxTurns: config.investigation.maxTurns,
      maxBudgetUsd: config.investigation.maxBudgetUsd,
      maxToolCalls: config.investigation.maxToolCalls,
      maxConsecutiveToolErrors: config.investigation.maxConsecutiveToolErrors,
      maxRepeatedEquivalentToolCalls: config.investigation.maxRepeatedEquivalentToolCalls,
      maxCumulativeInputTokens: config.tokens.maxCumulativeInputTokens,
      maxCumulativeOutputTokens: config.tokens.maxCumulativeOutputTokens,
    },
    usage,
    audit: {
      append: (event, payload) =>
        Promise.resolve(
          console.log(JSON.stringify({ event, reportDate, lineFingerprint, ...payload })),
        ),
    },
    checkpoint: () => ({ reportDate, lineFingerprint, ownerToken, playbook: playbookName }),
  });

  const options = buildAgentRuntimeOptions({
    cwd: '/tmp/cost-workspace',
    model: config.model.gatewayModelName ?? config.model.modelId ?? config.model.provider,
    sessionStore,
    maxTurns: config.investigation.maxTurns,
    maxBudgetUsd: config.investigation.maxBudgetUsd,
    costServer: toolServer,
    allowedTools,
    hooks,
    environment: modelEnvironment,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  });

  const prompt = buildCostGoal({
    reportDate,
    line,
    report: reportRecord.report,
    lineFingerprint,
    playbook: playbookName,
    allowedAccountIds,
    initialEvidenceIds: [],
    ...(priorAnalysis ? { priorAnalysis: priorAnalysis.value } : {}),
  });

  const resultStore = new S3WorkerResultStore(s3, evidenceBucket);
  await runWorker({
    executionId,
    reportDate,
    lineFingerprint,
    prompt,
    options: withResume(options, resumeSessionId) as never,
    finalAnswerToolName: FINAL_ANSWER_TOOL_NAME,
    classification: playbookName as CostClassification,
    evidenceCatalog: collectedEvidence,
    evidenceValidation: {
      minimumConfidence: config.evidence.minimumConfidenceForLikelyDriverIdentified,
      minimumEvidenceTypes: config.evidence.minimumEvidenceTypesForLikelyDriverIdentified,
      resourceEvidenceVerified: allowedTools.includes('mcp__cost__describe_resources'),
    },
    usage,
    resultStore,
    resultKey,
  });
}

await main();

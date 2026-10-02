import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const positiveInteger = z.number().int().positive();
const optionalTarget = z.string().min(1).nullable();

const NetworkSchema = z
  .object({
    vpcId: z.string().min(1),
    availabilityZones: z.array(z.string().min(1)).min(1),
    // Public, IGW-routed subnets, not private+NAT — see
    // docs/adr/0003-public-subnets-no-nat.md. The ECS worker/LiteLLM tasks
    // get a public IP per task (assignPublicIp) instead; inbound stays
    // blocked entirely by security groups regardless, so this costs
    // nothing extra over a NAT Gateway's ongoing hourly/data charges.
    publicSubnetIds: z.array(z.string().min(1)).min(1),
  })
  .nullable();

const EnvironmentSchema = z.object({
  connectorMode: z.enum(['mock', 'aws']),
  awsAccountId: optionalTarget,
  awsRegion: optionalTarget,
  requireExplicitTargetConfirmation: z.boolean(),
  targetConfirmation: optionalTarget,
  allowlists: z.object({
    // Linked accounts describe_resources/get_cost_and_usage(accountId=) may
    // touch — mirrors config/account-map.yaml's keys, not re-derived from it
    // so this file stays the single fail-closed source of truth for what
    // the worker's IAM boundary actually allows.
    awsAccounts: z.array(z.string().regex(/^\d{12}$/)),
  }),
  // Role name expected to exist (deployed out of band) in every allowlisted
  // linked account, assumed by ResourceDescribeConnector's cross-account
  // client factory. Null in dev/mock mode, where no real assume-role happens.
  crossAccountRoleName: optionalTarget,
  network: NetworkSchema,
  slack: z.object({ enabled: z.boolean(), channelId: optionalTarget }),
});

export const HarnessConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.enum(['dev', 'staging', 'prod']),
    environments: z.object({
      dev: EnvironmentSchema,
      staging: EnvironmentSchema,
      prod: EnvironmentSchema,
    }),
    productionSafety: z.object({
      failOnMissingTarget: z.boolean(),
      failOnMissingAllowlists: z.boolean(),
      requireAccountAndRegionConfirmation: z.boolean(),
      readOnly: z.literal(true),
      allowMutationTools: z.literal(false),
      allowShellTools: z.literal(false),
      allowFileWriteTools: z.literal(false),
      allowUnrestrictedWebTools: z.literal(false),
    }),
    configBucketKeys: z.object({ accountMap: z.string().min(1), playbooks: z.string().min(1) }),
    significance: z.object({
      significantChangePercent: z.number().positive(),
      // Report line labels to never enqueue an investigation for,
      // regardless of trend — see isNotable's own comment in
      // packages/core/src/cost-playbook.ts.
      excludedLabels: z.array(z.string().min(1)).default([]),
    }),
    memory: z.object({ retentionSeconds: positiveInteger }),
    locks: z.object({ ttlSeconds: positiveInteger }),
    investigation: z.object({
      maxDurationSeconds: positiveInteger,
      maxTurns: positiveInteger,
      maxBudgetUsd: z.number().positive(),
      maxToolCalls: positiveInteger,
      maxConsecutiveToolErrors: positiveInteger,
      maxRepeatedEquivalentToolCalls: positiveInteger,
      maxResultCharacters: positiveInteger,
    }),
    tokens: z.object({
      maxCumulativeInputTokens: positiveInteger,
      maxCumulativeOutputTokens: positiveInteger,
      maxFinalOutputTokens: positiveInteger,
    }),
    concurrency: z.object({
      maxGlobalInvestigations: positiveInteger,
      maxPerReportInvestigations: positiveInteger,
    }),
    evidence: z.object({
      minimumConfidenceForLikelyDriverIdentified: z.number().min(0).max(1),
      minimumEvidenceTypesForLikelyDriverIdentified: positiveInteger,
    }),
    agentSdk: z.object({
      sdkVersion: z.union([z.string(), z.number()]),
      cliVersion: z.union([z.string(), z.number()]),
      permissionMode: z.literal('dontAsk'),
      strictMcpConfig: z.literal(true),
      settingSources: z.tuple([]),
      enabledMcpTools: z.array(z.string().regex(/^mcp__cost__[a-z_]+$/)).min(1),
    }),
    model: z.object({
      provider: z.enum(['mock', 'anthropic', 'bedrock', 'litellm']),
      modelId: optionalTarget,
      // Only used when provider === 'litellm': the LiteLLM `model_name` sent
      // over the wire (config/litellm.yaml maps it to the real backend).
      gatewayModelName: optionalTarget,
      // Only used when provider === 'litellm': the real Bedrock foundation-
      // model ID/inference-profile ID config/litellm.yaml routes to, needed
      // here only to scope the LiteLLM service's own task-role IAM grant.
      upstreamBedrockModelId: optionalTarget,
      effort: z.string().min(1),
      temperature: z.number().min(0),
      promptVersion: z.string().min(1),
    }),
    sessionPersistence: z.object({
      enabled: z.literal(true),
      store: z.literal('s3-dynamodb'),
      resumeEnabled: z.literal(true),
    }),
    fargate: z.object({
      cpu: positiveInteger,
      memoryMiB: positiveInteger,
      taskTimeoutSeconds: positiveInteger,
      maximumConcurrentTasks: positiveInteger,
    }),
    slack: z.object({
      minimumUpdateIntervalSeconds: positiveInteger,
      oneThreadPerReportDate: z.literal(true),
    }),
    retention: z.object({
      reportMetadataDays: positiveInteger,
      evidenceDays: positiveInteger,
      sessionTranscriptDays: positiveInteger,
    }),
    featureFlags: z.object({
      resourceDescribeTools: z.boolean(),
      savingsRecommendations: z.boolean(),
    }),
  })
  .strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, 'utf8'));
}

/**
 * Same fail-closed shape as paco-troubleshoot-agent's `loadHarnessConfig`
 * (packages/config/src/runtime-config.ts): validates against the
 * environment actually being targeted, not just the file's own default
 * `environment:` field, and refuses to synth/deploy a non-dev environment
 * missing its target account/region/allowlist.
 */
export async function loadHarnessConfig(
  path: string,
  targetEnvironment?: string,
): Promise<HarnessConfig> {
  const config = HarnessConfigSchema.parse(await readYaml(path));
  const environment = targetEnvironment ?? config.environment;
  if (environment !== 'dev' && environment !== 'staging' && environment !== 'prod') {
    throw new Error(`Unknown target environment: ${environment}`);
  }
  const selected = config.environments[environment];
  if (selected.slack.enabled && !selected.slack.channelId) {
    throw new Error(
      `${environment}.slack.enabled requires ${environment}.slack.channelId to be set`,
    );
  }
  if (
    config.model.provider === 'litellm' &&
    (!config.model.gatewayModelName || !config.model.upstreamBedrockModelId)
  ) {
    throw new Error(
      'model.provider "litellm" requires model.gatewayModelName and model.upstreamBedrockModelId to be set',
    );
  }
  if (environment !== 'dev') {
    const missingTarget =
      !selected.awsAccountId || !selected.awsRegion || !selected.targetConfirmation;
    const emptyAllowlist = selected.allowlists.awsAccounts.length === 0;
    if (missingTarget || emptyAllowlist) {
      throw new Error(
        `${environment} configuration is fail-closed until target and allowlists are explicit`,
      );
    }
  }
  return config;
}

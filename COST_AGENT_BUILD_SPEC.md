# Cost-Saving Investigation Agent — Build Specification

## 0. Purpose

Build a read-only cost-driver investigation agent for the Blinx/PACO AWS estate. Every day,
`paco-daily-cost-report` (a separate, already-deployed repo) posts a "Cloud Spending Analysis" Slack
message: total spend plus a per-account/per-service breakdown, each with yesterday's cost, a
day-over-day trend, month-to-date spend, and a forecast. When someone tags this agent under that
message, it parses the report, identifies which lines moved enough to matter, gathers bounded AWS Cost
Explorer / Cost Anomaly Detection / Savings Plans / resource-inventory evidence, and replies in the
same Slack thread with a cited explanation of *why* — plus, where the evidence supports it, a
read-only savings recommendation naming an existing lever for a human to pull.

This is not a remediation system. It must never change production resources, never call
`paco-saving-lambda` (the separate repo that already owns EC2/RDS/Redshift/ECS/ASG start-stop and
Fargate Spot migration), and never expose account credentials, secrets, or write access of any kind.
See `docs/adr/0001-dedicated-bot-and-readonly-boundary.md` for the reasoning behind the read-only
boundary and the decision to run a dedicated Slack bot rather than extend `paco-troubleshoot-agent`'s.

All application code is Node.js with strict TypeScript. All AWS infrastructure is AWS CDK v2 in
TypeScript. No AWS resources are created manually.

## 1. Reference material (read-only, external to this repo)

- `paco-daily-cost-report/lambda/index.py` and `lib/cost-report-stack.ts` — the exact Cost Explorer
  queries and Slack Block Kit shape this agent parses. Treated as the source of truth for the report
  format; never modified by this project.
- `paco-saving-lambda/src/lambda/{scheduler-worker,fargate-spot-migrator}/index.py` — the existing
  mutation levers this agent may *name* in a recommendation but never *call*.
- `paco-troubleshoot-agent/AGENT_BUILD_SPEC.md` and its live implementation — the architectural
  pattern this agent adapts (Slack app_mention → parse → investigate → validated result → reply
  in-thread), and the source of every generically-reusable piece ported into this repo
  (`packages/slack-connector`, `packages/session-store`, `packages/agent-sdk-runtime`, the Slack
  Events envelope schema, the DynamoDB dedup/lock idioms, the parser/fingerprint conventions).
- `paco-troubleshoot-agent/Architecture.md` §4b — notes `RdsAuroraSchedulerStack`'s scale-down/up
  rules are currently **disabled**. A live signal this agent can cite if evidence shows Aurora running
  unscaled outside business hours.
- `paco-troubleshoot-agent`'s `config/litellm.yaml`, `config/harness.yaml`'s `model:` block, and
  `apps/infra/lib/litellm-service.ts` — the confirmed-working LiteLLM/Kimi K3 workaround for this same
  AWS account's broken Anthropic-on-Bedrock access, ported here as `docs/adr/0002`.

## 2. Build status

All four phases below are implemented and verified: `pnpm build && pnpm lint && pnpm typecheck &&
pnpm test` pass (85 tests), and `cdk synth` was confirmed to produce all six stacks correctly
(verified once with placeholder network values, then reverted — see the ADR-0001 follow-up note in
§8 on what's still fail-closed by design).

**Not done, deliberately, because it needs real infrastructure/credentials this build environment
doesn't have:**
- No `cdk deploy` has been run. `staging`/`prod` in `config/harness.yaml` remain fail-closed
  (`awsAccountId`/`awsRegion`/`network`/`crossAccountRoleName`/allowlists are `null` or need
  confirming) until someone with real account access fills them in.
- No Slack app has been created; `SlackSecret`/`SlackSigningSecret` are empty CDK-managed Secrets
  Manager containers waiting for out-of-band injection.
- No model provider credentials are configured. `config/harness.yaml`'s `model.provider` is `litellm`,
  routed at Kimi K3 (Moonshot AI) on Bedrock through a self-hosted LiteLLM gateway
  (`docs/adr/0002-litellm-model-gateway.md`) — the same workaround `paco-troubleshoot-agent` already
  uses in this same account, because direct Anthropic-on-Bedrock access is broken here (a Marketplace
  billing issue, not fixable in code). The `CostAgent-<env>-litellm` secret (gateway master key) and
  `CostAgent-<env>-model` secret (unused in `litellm` mode) are both empty CDK-managed containers.
- The cross-account read-only IAM role (`crossAccountRoleName` in `config/harness.yaml`) has not been
  created in PACO-Production/PACO-Non-Production — that's out-of-band provisioning this repo doesn't
  own (see §8).
- No load/acceptance test has been run against live infrastructure (spec §10's real-Slack-message test
  is the only thing meaningfully testable pre-deploy).

**Phase 1 — deterministic ingestion:**
- Cost-report parsing (`packages/core/src/cost-message-parser.ts`) from both Slack's structured
  `blocks` and the flattened, separator-free text Slack produces when a Block-Kit-only message is
  copied out of the UI.
- Per-line significance classification and fingerprinting
  (`packages/core/src/cost-playbook.ts`, `cost-fingerprint.ts`).
- The Slack Events API handler skeleton (signature verification, thread-root read, parse).

**Phase 2 — evidence & harness:**
- CDK stacks (`apps/infra/lib/stacks.ts`): `ConfigStack`, `DataStack`, `IntegrationStack`,
  `IngestionStack`, `HarnessStack` (ECS cluster + Step Functions supervisor, `apps/infra/lib/
  harness-state-machine.ts`), `MonitoringStack`.
- DynamoDB tables (`CostReportsTable`, `AnalysisCacheTable`, `ControlTable`, `AgentSessionsTable`), S3
  buckets (config, evidence, session), SQS queue + DLQ.
- The Claude Agent SDK harness (`packages/agent-sdk-runtime`): `runner.ts` (the SDK `query()` loop,
  including the direct `tool_use`-block final-answer capture and stream-stall handling ported from
  paco-troubleshoot-agent's hard-won fixes to this exact SDK version), `hooks.ts` (budget/security
  enforcement), `tool-server.ts` (the MCP evidence tools + `submit_final_analysis`), `prompt.ts`,
  `resume.ts`, `worker.ts`.
- Evidence connectors (`packages/cost-connectors`): `CostExplorerConnector`, `ResourceDescribeConnector`
  with cross-account STS role assumption, `PriorReportsConnector`, composed by tool name.
- The ECS Fargate worker entrypoint (`apps/agent-worker/src/main.ts` + `Dockerfile`) wiring all of the
  above together.
- The six supervisor Lambda functions (`apps/functions/{dispatch,resolve-context,validate-analysis,
  persist-result,notify-slack,handle-failure}`).
- The Slack handler extended with real dedup/cache/lock/concurrency/rate-limit coordination
  (`packages/aws-repositories/src/coordinate.ts`) and SQS enqueueing.

**Phase 3 — diagnosis quality:**
- `FinalCostAnalysis` Zod schema (`packages/schemas/src/cost-analysis.ts`) and independent
  re-validation (`packages/core/src/cost-analysis-validation.ts`, re-run by `validate-analysis`
  rather than trusting the worker's own self-reported validation — ADR-0004's pattern from the
  troubleshoot agent).
- Deterministic pre-routing kept deliberately to two playbooks
  (`NEW_SERVICE_OR_USAGE_TYPE`/`GENERIC` — see §6 for why), with the model choosing among the full
  seven-value `classification` enum in its final answer, once it has actually gathered evidence.

**Phase 4 — ops hardening:**
- One Slack thread per report date (`DynamoSlackThreadRegistry.claimThread`), every notification
  (`started`/`known_line_reused`/`analysis`/`failed`) replying into that same thread.
- `MonitoringStack`: DLQ-depth and Step-Functions-failure alarms, a starter dashboard.
- Not done: load/acceptance testing against live infrastructure (needs a deployment to test against).

## 3. Monorepo structure (as built)

```text
paco-saving-agent/
  apps/
    functions/
      slack-events/{handler,index}.ts        # parse, coordinate dedup/lock, enqueue, reply
      dispatch/{handler,index}.ts             # SQS -> Step Functions StartExecution
      resolve-context/{handler,index}.ts      # reload report/line, pick routing playbook
      validate-analysis/{handler,index}.ts    # independent re-validation of the worker's result
      persist-result/{handler,index}.ts       # cache write + lock/concurrency release
      notify-slack/{handler,index}.ts         # post into the one thread per report date
      handle-failure/{handler,index}.ts       # Catch-all release path
    agent-worker/
      src/main.ts                             # ECS entrypoint wiring the Agent SDK harness
      Dockerfile
    infra/
      bin/infra.ts                            # CDK app entrypoint, fail-closed env gating
      lib/{stacks,harness-state-machine,iam-policies,node-function}.ts
  packages/
    schemas/src/                              # cost-report, cost-analysis, cost-evidence, cost-tools
    core/src/                                 # parser, fingerprint, significance, budget, redaction,
                                               # execution-identity, cost-orchestration (pure, testable),
                                               # cost-analysis-validation
    config/src/                               # harness-config, playbooks-config, account-map-config
    slack-connector/src/                      # SlackWebApiClient
    session-store/src/                        # SessionStore impls (in-memory, S3, DynamoDB composite)
    agent-sdk-runtime/src/                    # sdk-contract, hooks, runner, tool-server, prompt, resume, worker
    aws-repositories/src/                     # DynamoDB/SQS/S3/Secrets adapters, async coordination
    cost-connectors/src/                      # Cost Explorer, resource-describe, cross-account, prior-reports
  config/
    account-map.yaml   harness.yaml   playbooks.yaml
  docs/adr/
    0001-dedicated-bot-and-readonly-boundary.md
  tasks/todo.md
  COST_AGENT_BUILD_SPEC.md
```

Every package and app has a real caller and real tests. There are no placeholder directories.

## 4. Data model

### `CostReportsTable`

Partition key: `reportDate` (`YYYY-MM-DD`). One item per day's report, written by `upsertReport`
(`packages/aws-repositories/src/dynamodb.ts`) with idempotent-on-Slack-event-ID semantics: `report`,
`slackChannel`, `slackThreadTs` are `if_not_exists` (first poster wins), `lastSeen`/`mentionCount`
always update.

### `AnalysisCacheTable`

Partition key: `lineFingerprint` (report date + line kind + label, per `cost-fingerprint.ts` — this
domain's `analysisKey` equivalent; there's no separate deployment-identity dimension since a cost
line has no "deployed version"). Caches a validated `FinalCostAnalysis` per line so a repeated
`@mention` reuses it with zero further Cost Explorer calls or Agent SDK sessions until
`cache.analysisTtlSeconds` expires.

### `ControlTable`

Locks (`LOCK#<lineFingerprint>`), concurrency reservations (`CONC#GLOBAL` / `CONC#REPORT#<date>`),
rate limits (`RATE#LINE#<lineFingerprint>`), the Slack thread registry (`SLACK#<reportDate>`), and
idempotency markers (`IDEMPOTENCY#slack:<eventId>`) — same conditional-write idioms as
paco-troubleshoot-agent's `ControlTable`, simplified to this domain's per-line unit of work (see
`packages/core/src/cost-orchestration.ts`'s comment on why no occurrence-counting is needed).

### `AgentSessionsTable`

Agent SDK session metadata/summaries (GSI `ByProjectKey`) plus the `lineFingerprint -> sessionId`
mapping (`DynamoDbCostSessionMapping`) so a worker restart resumes the exact session instead of
reconstructing one.

## 5. Evidence tools (MCP surface, read-only — implemented in `packages/agent-sdk-runtime/src/tool-server.ts`)

- `mcp__cost__get_report` — the pre-loaded report for this investigation (no AWS call).
- `mcp__cost__get_cost_and_usage` — CE `GetCostAndUsage` by SERVICE/USAGE_TYPE/LINKED_ACCOUNT/REGION,
  bounded date window. Query shapes reuse exactly what `paco-daily-cost-report/lambda/index.py`
  already proves works (`GroupBy LINKED_ACCOUNT`) — this agent doesn't reinvent the CE query patterns,
  only adds the drill-down groupings the daily summary doesn't need.
- `mcp__cost__get_cost_anomalies` — CE `GetAnomalies`.
- `mcp__cost__get_savings_plans_utilization` / `get_reservation_utilization` — SP/RI coverage.
- `mcp__cost__get_rightsizing_recommendations` — CE `GetRightsizingRecommendation` for EC2/RDS.
- `mcp__cost__describe_resources` — allowlisted `Describe*` calls (ECS services, RDS instances, EC2
  instances, Lambda configuration) via a cross-account assumed role into PACO-Production /
  PACO-Non-Production (`ResourceDescribeConnector` + `buildCrossAccountClientFactory`).
- `mcp__cost__get_prior_reports` — bounded direct `GetItem` lookups against `CostReportsTable` for the
  preceding N calendar dates (no GSI needed at this table's real scale of one write/day).

Every tool: Zod input schema, `readOnlyHint: true`, redact/truncate before returning to the model,
`isError: true` instead of leaking raw exceptions, an authorization check scoped to the report date
and an allowlisted account set (`tool-server.ts`'s `authorize()`).

## 6. Diagnostic playbooks

Deterministic pre-routing is kept to exactly two entries (`config/playbooks.yaml`,
`packages/config/src/playbooks-config.ts`'s `selectRoutingPlaybook`):

| Playbook | Trigger (derivable from the report line alone, no evidence call needed) | Enabled tools |
|---|---|---|
| `NEW_SERVICE_OR_USAGE_TYPE` | Line's trend is `new` | `get_report`, `get_cost_and_usage`, `get_prior_reports` |
| `GENERIC` | Everything else (any notable increase/decrease) | the full tool set in §5 |

This mirrors the *reason* for the incident agent's `GENERIC` fallback, not just its name: a cost line's
trend alone can only ever tell you "new" or "something changed, investigate" — it cannot say *why*
without evidence. The full seven-value classification the model can conclude with —
`NEW_SERVICE_OR_USAGE_TYPE`, `USAGE_GROWTH`, `SCALING_OR_DEPLOYMENT_CHANGE`, `RI_SP_COVERAGE_DROP`,
`ONE_OFF_SPIKE`, `FORECAST_OVERRUN`, `IDLE_OR_UNDERUTILIZED_RESOURCE`, `GENERIC` — lives in
`FinalCostAnalysisSchema.classification` (§7), decided by the model *after* it has gathered evidence,
not pre-decided by a routing table that has no way to know which of those seven actually applies.

## 7. Output contract (implemented: `packages/schemas/src/cost-analysis.ts`)

```ts
type FinalCostAnalysis = {
  classification: 'NEW_SERVICE_OR_USAGE_TYPE' | 'USAGE_GROWTH' | 'SCALING_OR_DEPLOYMENT_CHANGE'
    | 'RI_SP_COVERAGE_DROP' | 'ONE_OFF_SPIKE' | 'FORECAST_OVERRUN' | 'IDLE_OR_UNDERUTILIZED_RESOURCE' | 'GENERIC';
  status: 'LIKELY_DRIVER_IDENTIFIED' | 'HYPOTHESIS_ONLY' | 'INSUFFICIENT_EVIDENCE' | 'BUDGET_EXHAUSTED';
  summary: string;
  driver: string | null;
  confidence: number;
  evidence: Array<{ id: string; type: 'cost_explorer' | 'anomaly' | 'ri_sp' | 'resource' | 'deployment' | 'historical'; statement: string }>;
  hypotheses: Array<{ statement: string; confidence: number; supportingEvidenceIds: string[]; contradictingEvidenceIds: string[] }>;
  rejectedHypotheses: Array<{ statement: string; reason: string; evidenceIds: string[] }>;
  savingsRecommendations: Array<{
    action: string;
    lever: 'fargate-spot-migrator' | 'scheduler-worker' | 'rds-aurora-scheduler' | 'manual';
    estimatedMonthlySavingsUsd?: number;      // only ever set from a real tool result
    supportingEvidenceIds: string[];          // required to keep estimatedMonthlySavingsUsd — see below
    requiresHumanApproval: true;
  }>;
  limitations: string[];
};
```

`validateCostAnalysisEvidence` (`packages/core/src/cost-analysis-validation.ts`, independently
re-run by the `validate-analysis` Lambda, never trusting the worker's own self-reported validation):
every evidence claim must cite a real ID from the evidence catalog with a matching type;
`LIKELY_DRIVER_IDENTIFIED` requires a minimum confidence and evidence-type count
(`config/harness.yaml`'s `evidence.*`) or is downgraded to `HYPOTHESIS_ONLY`; confidence is capped at
0.7 when no `resource`-typed evidence was collected; and `estimatedMonthlySavingsUsd` is stripped from
any recommendation whose `supportingEvidenceIds` don't resolve to a real evidence record — the model
cannot invent a savings number, only cite one a tool actually returned.

## 8. IAM boundary (implemented: `apps/infra/lib/iam-policies.ts`)

Management-account Fargate task role: `ce:Get*` (CostAndUsage/Anomalies/SavingsPlansUtilization/
ReservationUtilization/RightsizingRecommendation), `savingsplans:DescribeSavingsPlans`,
`compute-optimizer:Get*`, `sts:AssumeRole` scoped to the exact cross-account role ARN in each
allowlisted linked account (never a wildcard). The assumed role itself, and the `Describe*`-only
permissions it grants in PACO-Production/PACO-Non-Production, are **provisioned out of band** —
this repo's CDK never creates IAM resources in another account. Explicitly excludes every mutation
action `paco-saving-lambda` already owns: no `ecs:UpdateService`, no EC2/RDS/Redshift start/stop, no
`PutCapacityProviderStrategy`, no IAM or billing writes, no `secretsmanager:GetSecretValue` beyond the
exact model/Slack/LiteLLM secret ARNs.

In `litellm` mode (the default — see §2 and `docs/adr/0002`), the worker task role gets **no**
`bedrock:InvokeModel` at all; that grant lives only on the standalone LiteLLM gateway service's own
task role, scoped to the exact `upstreamBedrockModelId`. The worker instead gets a dedicated security
group with egress only to the gateway, and reads the gateway's own secret (`CostAgent-<env>-litellm`),
never Bedrock credentials directly.

**Follow-up needed before a `staging`/`prod` deploy** (all fail-closed by design — `loadHarnessConfig`
refuses to synth a non-`dev` environment missing any of these):
1. A real VPC/subnet configuration (`environments.<env>.network` in `config/harness.yaml`).
2. `environments.<env>.awsAccountId`/`awsRegion`/`targetConfirmation`.
3. The cross-account read-only role deployed in PACO-Production/PACO-Non-Production, and its name set
   as `environments.<env>.crossAccountRoleName`.
4. A dedicated Slack app (bot token + signing secret injected into the CDK-created secrets).
5. Model provider credentials (`environments.<env>.connectorMode: aws` plus a real `model.provider`).

## 9. Slack behavior (implemented)

One thread per report date: `DynamoSlackThreadRegistry.claimThread` lets the first `@mention` claim
the thread for that `reportDate`; every later notification (`started`, `known_line_reused`,
`analysis`, `failed` — `apps/functions/notify-slack/handler.ts`) replies into that same thread,
regardless of which message a human tagged the bot under. Multiple replies within one thread as an
investigation progresses/completes is the same shape `paco-troubleshoot-agent` uses, not a
per-occurrence spam pattern — spec principle "never send one message per occurrence" is satisfied by
never creating a second top-level thread for a report already being tracked.

## 10. Testing

85 tests across 22 files, all passing with zero AWS credentials involved. Notable coverage:

- `cost-message-parser.test.ts`: the real "Cloud Spending Analysis - 2026-09-24" message, both as
  Block Kit blocks and as the flattened Slack-UI-copied text a user actually pasted.
- `cost-orchestration.test.ts`: cache-hit / rate-limited / lock-contended / concurrency-throttled /
  enqueued decision paths, including that a redelivered Slack event derives a different owner token
  for the same line (so a retried `StartExecution` is idempotent without colliding with the original).
- `cost-analysis-validation.test.ts`: confidence/evidence-type downgrades, unknown evidence ID
  detection, and the `estimatedMonthlySavingsUsd`-stripping rule.
- `harness-config.test.ts`: the real `config/harness.yaml` loads and validates for `dev`, and fails
  closed for `prod` exactly as shipped (no target account/region/network yet).
- CDK: verified once via a real `cdk synth` (placeholder VPC values, immediately reverted) that all
  six stacks — including the ECS Fargate task definition, Step Functions ASL, and all six
  esbuild-bundled Lambda functions — construct without error.

`pnpm build && pnpm lint && pnpm typecheck && pnpm test` must stay green with zero AWS credentials.

## 11. Definition of done

- [x] Parser round-trips the real cost-report message (Block Kit and flattened text) identically.
- [x] An unmapped account name still parses as an `account` line with `accountId` unset.
- [x] Full Agent SDK harness (hooks, budgets, resume, evidence tools, structured final answer) wired
      end-to-end in the ECS worker entrypoint.
- [x] Independent re-validation of the worker's analysis (never trusts self-reported validation).
- [x] Strictly read-only IAM boundary; cross-account access is describe-only via an out-of-band role.
- [x] One Slack thread per report date; every notification replies into it.
- [x] `cdk synth` succeeds for all six stacks.
- [ ] Deployed to a real AWS account. **Not done** — needs real account/VPC/Slack app/model
      credentials only the user can provide; see §8's follow-up list.
- [ ] Live end-to-end test against a real Slack workspace and AWS Cost Explorer. **Not done** — same
      reason.

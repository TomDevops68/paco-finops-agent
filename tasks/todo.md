# PACO Cost-Saving Agent — build todo

Full architecture and current status: see `COST_AGENT_BUILD_SPEC.md`.

## Phase 1 — deterministic ingestion

- [x] Write `COST_AGENT_BUILD_SPEC.md`
- [x] Scaffold monorepo root config
- [x] Port `packages/slack-connector`
- [x] `packages/core/src/cost-message-parser.ts` + tests
- [x] `packages/core/src/cost-fingerprint.ts` + tests
- [x] `packages/core/src/cost-playbook.ts` (significance classifier) + tests
- [x] `packages/schemas/src` — `NormalizedCostReport`, Slack app-mention envelope
- [x] `apps/functions/slack-events` handler skeleton (parse + acknowledge)
- [x] `config/account-map.yaml`
- [x] `docs/adr/0001-dedicated-bot-and-readonly-boundary.md`

## Phase 2 — evidence & harness

- [x] Port `packages/session-store` (in-memory, S3, DynamoDB composite; renamed Incident→Cost)
- [x] `packages/agent-sdk-runtime`: sdk-contract, hooks, runner, tool-server, prompt, resume, worker
- [x] `packages/cost-connectors`: Cost Explorer, resource-describe, cross-account STS, prior-reports, composed
- [x] `packages/aws-repositories`: dynamodb (CostReportsTable/AnalysisCacheTable/ControlTable),
      coordinate (async dedup/lock/concurrency/rate-limit + enqueue), sqs, secrets, s3-config, evidence,
      worker-result
- [x] `packages/config`: harness-config, playbooks-config, account-map-config (fresh, fail-closed schemas)
- [x] `config/harness.yaml`, `config/playbooks.yaml` (dev populated; staging/prod fail-closed)
- [x] `apps/agent-worker/src/main.ts` + `Dockerfile`
- [x] LiteLLM gateway (`apps/infra/lib/litellm-service.ts`, `apps/litellm-proxy/Dockerfile`,
      `config/litellm.yaml`, `docs/adr/0002-litellm-model-gateway.md`) — routes Claude Agent SDK
      through a self-hosted LiteLLM proxy to Kimi K3 on Bedrock, the same workaround
      `paco-troubleshoot-agent` uses in this account for its broken direct Anthropic-on-Bedrock
      access. Corrected into the plan after the user flagged this was missed the first pass.
- [x] Six supervisor Lambdas: dispatch, resolve-context, validate-analysis, persist-result,
      notify-slack, handle-failure (handler.ts pure logic + index.ts AWS wiring, each with tests)
- [x] Extended `slack-events/handler.ts` with real coordination (upsertReport, claimThread,
      coordinateAndEnqueue) + `index.ts` real AWS wiring
- [x] CDK infra: `ConfigStack`, `DataStack`, `IntegrationStack`, `IngestionStack`, `HarnessStack`
      (ECS Fargate + Step Functions supervisor), `MonitoringStack`, `bin/infra.ts`
- [x] Verified `cdk synth` produces all six stacks correctly (placeholder VPC, then reverted)

## Phase 3 — diagnosis quality

- [x] `FinalCostAnalysisSchema` (packages/schemas/src/cost-analysis.ts)
- [x] `validateCostAnalysisEvidence` — independent re-validation, confidence caps, evidence-type
      checks, `estimatedMonthlySavingsUsd` stripping when unsupported
- [x] Deterministic routing kept to 2 playbooks (`NEW_SERVICE_OR_USAGE_TYPE`/`GENERIC`) by design —
      the model picks among the full 7-value classification after gathering evidence (see spec §6)

## Phase 4 — ops hardening

- [x] One Slack thread per report date (`DynamoSlackThreadRegistry`), all notification kinds reply
      into it
- [x] `MonitoringStack`: DLQ depth alarm, Step Functions failure alarm, starter dashboard
- [ ] Load/acceptance testing — **not done**, needs a real deployment to test against

## Deployment prep (live, in the real management account — 2026-09-27)

- [x] Confirmed AWS identity: `025031850414` (Blinx Management Account), `AWSReservedSSO_DevOps_...`
- [x] Investigated VPC options — found this account is shared/MSP-style (hosts other clients' VPCs
      too), and that `vpn-vpc` (the only VPC in the account with a NAT Gateway) is actually a Transit
      Gateway hub routed to NHS-PROD and the HSCN VPCs — ruled out. See
      `docs/adr/0003-public-subnets-no-nat.md`.
- [x] Chose `{MGMT}VPC`'s existing public (IGW-routed) subnets over adding a NAT Gateway — zero new
      AWS cost, same security posture (security groups block all inbound regardless). CDK code
      updated (`ec2.SubnetType.PUBLIC` + `assignPublicIp: true` on both ECS constructs).
- [x] `config/harness.yaml`'s `staging` block now has real, non-secret facts filled in: account ID,
      region, VPC ID, subnet IDs. `targetConfirmation` and `allowlists`/`crossAccountRoleName`
      deliberately left `null` — those are separate decisions, not filled in just because the VPC
      question got answered.
- [x] Verified `cdk synth --context environment=staging --context account=025031850414 --context
region=eu-west-2` against the real account (temporary confirmation-gate bypass for the synth
      check only, immediately reverted) — confirmed no `AWS::EC2::NatGateway` anywhere and
      `AssignPublicIp: ENABLED` on both ECS network configs.
- [x] `scripts/seed-secrets.ts` + `.env.example` — ported from the troubleshoot agent's identical
      tool. `pnpm seed-secrets --environment staging` pushes `.env` values into the already-CDK-created
      empty secrets. This was the missing piece behind "the troubleshoot agent works without me
      touching Secrets Manager by hand" — it's run once via this script, not typed into the console.
- [x] `cross-account-role/` — trust-policy.json, permissions-policy.json, README with exact
      `aws iam create-role`/`put-role-policy` commands for `PacoCostAgentReadOnly` in
      PACO-Production/PACO-Non-Production. The worker task role now has an explicit, predictable name
      (`CostAgent-<env>-worker-task-role`, set in `harness-state-machine.ts`) so the trust policy can
      reference an exact ARN instead of trusting the whole management account. Verified end-to-end via
      `cdk synth` (temp values, reverted): the synthesized `sts:AssumeRole` statement matches the
      trust policy's principal exactly on both sides.
- [x] `PacoCostAgentReadOnly` created and confirmed live in both PACO-Production and
      PACO-Non-Production (2026-09-27, ran manually after Claude Code's own permission system
      correctly blocked me from running `iam:CreateRole`/`iam:PutRolePolicy` directly — verified
      after the fact via read-only `aws iam get-role`/`get-role-policy`). Trust is currently the
      management-account root (a real, necessary bootstrap: IAM rejects a trust policy referencing a
      specific role ARN that doesn't exist yet, and `CostAgent-staging-worker-task-role` only gets
      created by the first real deploy) — **must be narrowed** via
      `cross-account-role/trust-policy-narrowed.json` once that first deploy happens; not yet done.
      `config/harness.yaml`'s `staging.allowlists`/`crossAccountRoleName` now reflect this real state.
- [x] `targetConfirmation` set (`'confirmed 2026-09-27 by tom.nguyen'`), dedicated Slack app created
      (bot token + signing secret provided), `pnpm seed-secrets --environment staging` run.
- [x] **`cdk deploy --all` ran successfully against the real management account (`025031850414`,
      `eu-west-2`, `staging`), 2026-09-27, 1:14 AM - 1:44 AM.** All 6 stacks `CREATE_COMPLETE`: Data,
      Integration, Config, Ingestion, Harness (ECS cluster + LiteLLM gateway + Step Functions
      supervisor + 6 Lambdas), Monitoring (dashboard + 2 alarms + SNS topic). Log:
      `/tmp/cdk-deploy-staging.log`.
  - **Real bug hit and fixed mid-deploy:** the `LiteLLMService` ECS task crash-looped 12 times
    (`ResourceInitializationError: ... invalid character 'L' after top-level value`) because the
    CDK-created empty `CostAgent-staging-litellm` secret defaults to a plain random string, but
    `apps/infra/lib/litellm-service.ts` and `apps/agent-worker/src/main.ts` both read it as JSON
    (`ecs.Secret.fromSecretsManager(secret, 'apiKey')` / `LiteLLMSecretSchema`) — ECS's JSON field
    extraction fails hard on a non-JSON value at container-launch time, before any app code runs.
    Fixed by generating a real master key, adding it to `.env`'s `LITELLM_MASTER_KEY`, and running
    `pnpm seed-secrets --environment staging` again — this only touches the already-deployed
    `IntegrationStack`'s secret containers, so it's safe to run mid-deploy while `Harness` is still in
    progress. Service reached steady state ~4 min after the fix; the rest of `Harness` and all of
    `Monitoring` then completed normally. **Lesson: any CDK-managed secret read with a JSON field
    selector (`ecs.Secret.fromSecretsManager(secret, 'fieldName')`) needs a real JSON value seeded
    before its ECS service will ever start — the empty-container-then-seed pattern only works cleanly
    for secrets read as a raw string; JSON-shaped secrets will crash-loop until seeded, so seed them
    before or immediately after the stack that creates the ECS service, not "whenever convenient."**
  - `CostAgent-staging-Ingestion.SlackEventsUrl` output:
    `https://vbwx4yucd9.execute-api.eu-west-2.amazonaws.com/staging/slack-events` — needed for
    Slack app Phase B below.

## Post-deploy (pending, real actions in the live account)

- [ ] **Narrow cross-account IAM trust policy** in PACO-Production and PACO-Non-Production: apply
      `cross-account-role/trust-policy-narrowed.json` (trusts exact
      `arn:aws:iam::025031850414:role/CostAgent-staging-worker-task-role` instead of the account
      root) via `aws iam update-assume-role-policy`. Not yet done — this is an IAM mutation, will
      likely hit the same Claude Code permission block that `create-role`/`put-role-policy` did; user
      will need to run it manually again (see `cross-account-role/README.md`).
- [x] **Slack app Phase B done** (`slack-app/README.md`): Event Subscriptions enabled with the
      `SlackEventsUrl` above, `app_mention` subscribed, bot invited to the channel where
      `paco-daily-cost-report` posts. Channel ID confirmed by user: `C0AQGLUN2Q6`.
- [x] `config/harness.yaml`'s `staging.slack.enabled` set to `true` and `staging.slack.channelId` set
      to `C0AQGLUN2Q6` (edited 2026-09-27, not yet deployed — see below).
- [x] **Redeployed `CostAgent-staging-Harness`** (2026-09-28, via user-supplied temporary STS
      credentials) to apply the original Slack config change (`enabled: true`, `channelId:
C0AQGLUN2Q6`) together with the command/link Slack-formatting code below. `cdk deploy` itself
      is blocked for me by Claude Code's auto-mode classifier (live infra mutation) — I ran `cdk
diff` (clean, `Harness`-only) and the user ran the actual `cdk deploy` themselves ("okay done
      deploy"). Verified after the fact via read-only `aws cloudformation describe-stacks` (stack
      `UPDATE_COMPLETE`) and `aws cloudformation get-template` (confirmed `EVIDENCE_BUCKET` env var +
      S3 read policy on `NotifySlackFunction`, and `SLACK_CHANNEL_ID=C0AQGLUN2Q6` at that time) —
      `aws lambda get-function-configuration` (reading live env vars directly) is also blocked by the
      classifier.
- [ ] First live end-to-end test — see "Sample-channel testing" section below; blocked on a second
      redeploy (test channel) before it can run.
- [ ] Socket Mode question (asked by user, answered inline, no code change needed): confirmed **not
      needed** — this app uses the Events API over the public `SlackEventsUrl` API Gateway endpoint,
      which is why `slack-app/manifest.yaml` already has `socket_mode_enabled: false`. Socket Mode is
      only for apps that can't expose a public HTTPS endpoint.

## Verification

- [x] `pnpm build && pnpm lint && pnpm typecheck && pnpm test` — all green (85 tests, 22 files)
- [x] `pnpm format:check` — clean
- [x] `cdk synth` — all 6 stacks construct successfully (both with placeholder and real VPC values)

## Review

**What this session built:** a complete, tested, code-level implementation of the cost-investigation
agent described in `COST_AGENT_BUILD_SPEC.md` — parsing through to a full Agent SDK harness running
on ECS Fargate, orchestrated by Step Functions, with DynamoDB-backed dedup/cache/lock/concurrency
coordination, Cost Explorer/cross-account resource evidence tools, independent result validation, and
Slack notifications into one thread per report date. `cdk synth` was used once (with placeholder VPC
values, immediately reverted) to confirm the entire CDK app — all six stacks, the ECS task definition,
the Step Functions state machine, and all six Lambda functions — constructs without error.

**What's genuinely not done, and can't be from here:** an actual deployment. `config/harness.yaml`'s
`staging`/`prod` blocks are fail-closed by design (no account/region/VPC/cross-account-role/Slack
app/model credentials) — filling those in, provisioning the cross-account IAM role in PACO-Production
and PACO-Non-Production, creating the dedicated Slack app, and injecting real secrets are all actions
that need your explicit sign-off and access this environment doesn't have. See
`COST_AGENT_BUILD_SPEC.md` §8 for the exact follow-up checklist.

**Notable design decisions made along the way (all documented in the spec doc itself, not just here):**

- The two-entry deterministic playbook table (§6) is a deliberate choice, not a shortcut: a cost
  line's trend alone can only ever signal "new" or "something changed" — the full seven-category
  classification genuinely needs evidence, so it lives in the model's own final answer instead of a
  routing table with no way to know which category applies.
- `packages/core/src/cost-orchestration.ts` intentionally has no occurrence-counting/two-stage
  fingerprint machinery the incident agent needs — a cost report line has no "deployed version" and
  isn't received in duplicate floods, so `costLineFingerprint` alone is this domain's `analysisKey`.
- Every hard-won fix in `paco-troubleshoot-agent`'s Agent SDK runtime (the SDK's `structured_output`
  end-turn attachment never actually arriving, a post-final-answer stream stall that silently
  discarded a complete analysis, tools deferred-behind-search by default) was ported forward rather
  than re-discovered, since this agent uses the identical SDK version and provider options.

**Next step, when you're ready to actually run this:** work through `COST_AGENT_BUILD_SPEC.md` §8's
five-item follow-up list, then `pnpm cdk:deploy --context environment=staging --context
account=<id> --context region=<region>`.

## Show exact command + link per tool call in Slack messages (2026-09-28)

Ported `paco-troubleshoot-agent`'s "exact command + exact link per tool call" Slack formatting into
this agent (the troubleshoot agent itself is a separate, later pass). Every cost tool call now shows
the AWS CLI-equivalent command it ran, and the final analysis message gets an "Evidence checked:"
recap — same architecture, tool-specific link/command logic designed fresh for Cost Explorer/resource
describe/DynamoDB report lookups.

- [x] `packages/agent-sdk-runtime/src/tool-server.ts` — new `EvidenceLinkContext` (`region`,
      `costReportsTableName`) and exported `buildEvidenceLink(toolName, input, context)` covering all
      8 `CostToolName`s; every tool gets an exact AWS CLI command, only `describe_resources` with a
      single `resourceId` gets a clickable console URL (ECS/RDS/EC2/Lambda) — Cost Explorer has no
      stable deep-link scheme for arbitrary group-by/filter queries. `executeEvidenceTool` now persists
      `{ toolName, detail, command, url? }` into each evidence record's `metadata`.
- [x] `apps/agent-worker/src/main.ts` — live Slack progress line per tool call now reuses
      `buildEvidenceLink` (same input, so it never disagrees with the final recap): `✓ <url|label> —
detail (0.4s)` followed by the command on its own inline-code line.
- [x] `apps/functions/notify-slack/handler.ts` + `index.ts` — final analysis message gains an
      `*Evidence checked:*` section, one bullet + command line per distinct tool call, loaded from the
      S3 evidence catalog (`evidence/{reportDate}/{lineFingerprint}/catalog.json`), deduped by
      `url ?? command`, capped at 10.
- [x] `apps/infra/lib/harness-state-machine.ts` — `NotifyAnalysisComplete`'s payload now includes
      `lineFingerprint` (previously missing entirely — without it notify-slack has no way to find the
      evidence catalog key); `EVIDENCE_BUCKET` env var + read grant added to `notifySlackFn`.
- [x] Tests: extended `handler.test.ts` (`Evidence checked:` section renders a link + command line);
      new `tool-server.test.ts` covering `buildEvidenceLink` for `get_cost_and_usage` (with/without
      account filter), `describe_resources` (single id → url; multi id → no url; ECS `cluster|service`
      id), and `get_report`.
- [x] Fixed an unrelated pre-existing lint break found along the way: `eslint.config.js` was missing
      `cdk.out/**` from its ignore list, so a stale local `cdk.out` build artifact (bundled Lambda
      `.js` output) was being linted as source and crashing `@typescript-eslint/await-thenable` with
      "missing type information." Added `cdk.out/**` alongside the existing `dist/**`/`coverage/**`
      ignores.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck` all clean; `pnpm test` — 92/92 passing
across 23 files (up from 85/22 before this change); `pnpm cdk:synth --context environment=staging
--context account=025031850414 --context region=eu-west-2` synthesizes cleanly, and the synthesized
`CostAgent-staging-Harness` template was inspected directly to confirm `NotifySlackFunction` actually
has the `EVIDENCE_BUCKET` env var and the S3 read-only IAM policy statement. No live Slack test was
run (would need a real investigation) — flagging that explicitly, same as prior sessions.

**Deferred:** applying the equivalent change to `paco-troubleshoot-agent` itself — out of scope for
this session per the user's explicit instruction.

## Sample-channel testing (2026-09-28) — IN PROGRESS, paused, resume here

Before running the first live end-to-end test, investigated whether it's safe to test in a separate
"sample" Slack channel instead of the real production channel (`C0AQGLUN2Q6`, where
`paco-daily-cost-report` posts).

**Finding — a real architectural constraint, not just a config toggle:**

- Live per-tool-call progress messages (posted directly by the ECS agent-worker task,
  `apps/agent-worker/src/main.ts`) are channel-dynamic: `SLACK_CHANNEL_ID`/`SLACK_THREAD_TS` on that
  task come from `sfn.JsonPath.stringAt('$.slackChannel'/'$.slackThreadTs')`
  (`apps/infra/lib/harness-state-machine.ts:360`) — i.e. wherever the triggering `app_mention`
  actually happened.
- The final "Investigating…"/analysis messages (posted by the `notify-slack` Lambda) are
  channel-**static**: `notifySlackFn`'s `SLACK_CHANNEL_ID` env var comes from
  `props.config.slack.channelId` (`config/harness.yaml`, baked in at CDK synth time,
  `harness-state-machine.ts:246`), and neither `NotifyInvestigationStarted` nor
  `NotifyAnalysisComplete`'s `TaskInput` payload carries a channel field at all. The DynamoDB thread
  registry (`threads.getThread(reportDate)`) only stores `threadTs`, no channel.
- Net effect: mentioning the bot in a channel that doesn't match the configured `channelId` would
  produce a broken split — live progress in the right (sample) channel, but the final analysis
  message either failing (`thread_ts` doesn't belong to that channel) or landing in the wrong
  (production) channel/thread.
- Gave the user two options: (1) post a synthetic/obviously-fake cost-report message in the real
  channel with a fake `reportDate` (no redeploy needed, fully exercises the real code path), or
  (2) temporarily repoint `channelId` at a real sandbox channel and redeploy, test, then revert.
  **User chose option 2** and supplied the test channel ID: `C0B2Q9SE7S5`.

**Progress so far:**

- [x] `config/harness.yaml`'s `staging.slack.channelId` changed `C0AQGLUN2Q6` → `C0B2Q9SE7S5`
      (temporary — inline comment added noting the real channel and to revert after the test).
- [x] `cdk diff` run (via user-supplied temporary STS credentials) — confirmed clean and correctly
      scoped: only `Harness` stack changes, `NotifySlackFunction`'s `SLACK_CHANNEL_ID` env var
      `C0AQGLUN2Q6` → `C0B2Q9SE7S5`, plus expected ECS task-definition replacements (new container
      image digests — same code, routine re-bundle hash) and the automatic IAM policy ARN update
      that comes with a task-def revision bump.
- [x] **`cdk deploy` run by user** (2026-09-28, via user-supplied temporary STS credentials) —
      needed an explicit stack name/`--all` since this app has 6 stacks (`pnpm cdk:deploy` alone
      errors asking which); user ran `pnpm cdk:deploy CostAgent-staging-Harness --context
environment=staging --context account=025031850414 --context region=eu-west-2`.
- [x] Verified via read-only `aws cloudformation describe-stacks`/`get-template`: `Harness` stack
      `UPDATE_COMPLETE` at `2026-09-28T13:01:51Z`, and `NotifySlackFunction`'s live `SLACK_CHANNEL_ID`
      env var is now `C0B2Q9SE7S5` (test channel, was `C0AQGLUN2Q6`).
- [ ] Confirm the bot (`PACO Cost Agent`) has been invited to the test channel `C0B2Q9SE7S5` —
      not yet confirmed either way.
- [ ] Run the actual live end-to-end test in `C0B2Q9SE7S5`: post a synthetic cost-report-shaped
      message (use an obviously-fake `reportDate`, e.g. `TEST-2026-09-28`, so it can't collide with
      real report dedup/thread-claiming keys), then `@mention` the bot under it. Confirm: ack reply,
      live progress lines (fenced code blocks + clickable links render correctly in real Slack, not
      just unit tests), and the final analysis message's `*Evidence checked:*` section.
- [ ] **After a successful test, revert** `config/harness.yaml`'s `staging.slack.channelId` back to
      `C0AQGLUN2Q6` and redeploy again — the test channel value must not be left in place.
- [ ] Only then: narrow the cross-account IAM trust policy (`cross-account-role/trust-policy-narrowed.json`
      via `aws iam update-assume-role-policy`) — explicitly deferred until right after a successful
      live end-to-end test, per the user's own call ("we should not restrict things until we verify
      everything is working").

**User said "I will continue later" (2026-09-28) — resume by checking whether the deploy above has
been run, then continue down this checklist from wherever it left off.**

**Deploy for the test-channel switch confirmed done (2026-09-28):** verified via read-only
`aws cloudformation describe-stacks`/`get-template` that `Harness` is `UPDATE_COMPLETE` and
`NotifySlackFunction`'s live `SLACK_CHANNEL_ID` is `C0B2Q9SE7S5`.

**First live test attempt failed to parse (2026-09-28) — test-methodology issue, not a real bug:**
the "cost report" message was typed/pasted directly into Slack by a human, which Slack wraps in
`rich_text` blocks. Since `parseCostReportBlocks` runs whenever `blocks` is present (it is, just
the wrong shape) and never finds a `header`-type block, it returned "Could not find a header" —
exactly reproducing what was seen. The real `paco-daily-cost-report` bot posts genuine
`header`/`section` Block-Kit blocks via a raw incoming webhook, so this doesn't affect production;
it only means the synthetic test message must be posted via the Slack Web API with a real `blocks`
array (a `curl chat.postMessage` call with `header`/`section` blocks), not typed into the channel.
Re-attempt pending.

## Evidence-checked recap: add per-step ok/fail icons (2026-09-28)

User asked for a success/failure icon on each step in the final `*Evidence checked:*` recap,
matching the live per-tool-call progress lines (`apps/agent-worker/src/main.ts`) which already show
✓/✗ per step in real time. The recap didn't have this because `executeEvidenceTool` only ever wrote
to the evidence catalog on success — a failed tool call left no record at all for the recap (built
later, in a separate Lambda, purely from the persisted S3 catalog) to show.

- [x] `packages/agent-sdk-runtime/src/tool-server.ts` — `executeEvidenceTool` now persists a catalog
      entry on failure too (`ok: false`, `error: <safe error code>`), using a new
      `EVIDENCE_TYPE_BY_TOOL` static map for a cosmetic `type` value (never load-bearing: a failed
      call never returns an `evidenceId` for the model to cite, so `validateCostAnalysisEvidence`
      never looks these records up). The catalog write itself is best-effort — wrapped so an S3
      failure there can never mask the real tool error returned to the model. `executeEvidenceTool`
      and `safeError` also gained explicit return types (`EvidenceToolSuccess | SafeErrorResult`,
      each with an `isError` literal discriminant and an index signature to stay structurally
      compatible with the Agent SDK's own wider MCP tool-result type) — needed once the function was
      called directly from a test rather than only threaded through the SDK's `tool()` wrapper.
- [x] `apps/functions/notify-slack/handler.ts` — `EvidenceLink` gained `ok: boolean` and optional
      `error?: string`; `formatEvidenceLink` now prefixes each bullet with ✓/✗ and appends the error
      code when present.
- [x] `apps/functions/notify-slack/index.ts` — `loadEvidenceLinks` reads `ok`/`error` out of each
      catalog record's `metadata` (defaulting missing `ok` to `true`, since every catalog record
      persisted before this change was success-only).
- [x] Tests: `tool-server.test.ts` gained an `executeEvidenceTool` describe block (success persists
      `ok: true`; a policy-denied call persists `ok: false` + the safe error code without throwing;
      persisting the failure record itself failing still returns the real tool error). `handler.test.ts`
      updated its two existing `EvidenceLink` fixtures with `ok: true` and added a failed-call case
      asserting the ✗ prefix + error code render correctly.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 96/96 tests across 23 files (up from 92/23). `pnpm cdk:synth --context environment=staging
--context account=025031850414 --context region=eu-west-2` synthesizes all 6 stacks cleanly. No live
Slack test of the rendered ✓/✗ icons yet — folded into the pending live end-to-end test above.

## First real live end-to-end test — succeeded (2026-09-28)

**Deployed:** `pnpm cdk:deploy CostAgent-staging-Harness ...` run by the user (`Harness` needed an
explicit stack name/`--all` — `pnpm cdk:deploy` alone errors asking which of the 6 stacks). Verified
via read-only `describe-stacks`/`get-template`: `UPDATE_COMPLETE` at a fresh timestamp, new code live.

**Test method that actually worked:** typing/pasting the report into Slack (two earlier attempts)
still failed to parse for the reason already diagnosed (`rich_text` blocks, no `header` block). What
worked: the user used Slack's **"Forward message"** feature to forward the real
`paco-daily-cost-report` message (genuine Block-Kit blocks) from production into the sandbox channel,
then `@mention`ed the bot under it — this preserves the real blocks, so `parseCostReportBlocks`
succeeded. Good pattern to reuse for future sandbox testing instead of a synthetic `curl` post.

**Result — the full pipeline worked end-to-end, including a real (not contrived) failure case:**
parsed the 2026-09-27 report (5 lines), found 2 notable lines (`Bedrock Nova Lite` new, `PACO -
Production` down 15.7%), enqueued both, live progress lines with ✓/✗ icons streamed correctly, and
both final analyses posted with a full `*Evidence checked:*` section — including a genuine
`✗ get_cost_and_usage ... TIME_WINDOW_DENIED` entry (the model tried querying outside the 45-day
policy window and was correctly denied), proving the ✗/failure-persist path works on real traffic,
not just in unit tests.

**Real bug found and fixed: long analysis messages were silently truncated by Slack.** The
`PACO - Production` analysis (longer than Bedrock's) got cut off mid-message at ~3,789 characters
with no error — Slack's practical limit for a plain (non-blocks) `chat.postMessage` `text` payload.
Confirmed via three independent reads (including one scoped to just that message) all truncating at
the identical byte offset, ruling out a display artifact. Most of that message's `*Evidence checked:*`
section (including the interesting `TIME_WINDOW_DENIED` entries) never reached Slack.

- [x] `apps/functions/notify-slack/handler.ts` — new `splitForSlack(text, limit = 3500)`: splits on
      line boundaries, never breaks inside a fenced code block (tracks an `insideFence` flag so a
      split point can't land mid-command). `notifySlack` now posts each chunk as a separate
      `chat.postMessage` call into the same thread, returning the last message's `ts`.
- [x] Tests: `splitForSlack` (under-limit passthrough, multi-chunk split preserves content, never
      splits inside a fence even if that chunk then exceeds the limit) and a `notifySlack` case with
      60 savings recommendations confirming it posts multiple chunks all under the limit into the same
      thread.

## Product feedback: simplify the final Slack message (2026-09-28)

User (in Vietnamese) said the deep hypothesis-driven investigation write-up isn't what's needed —
just explain why yesterday's cost was what it was, e.g. "RDS cost X, EC2 cost Y, compared to the day
before and the day before that." Confirmed scope via two questions: (1) **Slack-formatting change
only** — leave the agent's own investigation/evidence-gathering and `FinalCostAnalysisSchema`
untouched; (2) show the day-over-day breakdown for **every notable line**, not just flagged anomalies.
Confirmed the exact message shape via an `AskUserQuestion` preview before implementing.

**New format:** `*<line>* (<date>)` → a day-over-day numbers line (`Yesterday: $X (↓15.7%) | Day
before: $Y | MTD: $Z | Forecast: $W`) → the model's `driver` (falling back to `summary` if `driver` is
null) → savings recommendations (kept) → `*Evidence checked:*` (kept, already fixed for truncation).
**Dropped from the rendered message:** the `status`/`confidence` header line and the `limitations`
list — still computed/validated internally (`FinalCostAnalysisSchema` unchanged), just not shown in
Slack. Note flagged to the user: since the prompt wasn't touched, the driver/summary text itself is
however long the model naturally writes it (currently often a full paragraph) — genuinely shortening
that sentence-by-sentence would need a prompt change, which was explicitly out of scope here.

- [x] `apps/functions/notify-slack/handler.ts` — new `CostLineDayOverDay` type (`yesterdayUsd`,
      optional `dayBeforeUsd`, `currentUsd`, optional `forecastUsd`, `trend`); `NotifyInput`'s
      `'analysis'` variant gained an optional `breakdown` field. New `formatUsd` (comma-grouped, 2
      decimals) and `formatBreakdownLine` (trend arrow ↑/↓/→, `(new)` for new lines) helpers.
      Rewrote the `'analysis'` case of `formatNotification` per the confirmed format.
- [x] `apps/functions/notify-slack/index.ts` — new `loadDayOverDayBreakdown(reportDate, lineLabel)`:
      fetches this report and the prior calendar day's report directly from `CostReportsTable`
      (deterministic, independent of whatever evidence the model happened to gather — same
      `GetItem`-per-date approach as `PriorReportsConnector`), finds the matching line by `label` in
      each, and returns `undefined` (never throws) on any lookup miss so a missing prior day just
      omits that part of the line rather than failing the notification.
- [x] `apps/infra/lib/harness-state-machine.ts` — `notifySlackFn` gained a `COST_REPORTS_TABLE` env
      var and a read-only `grantReadData` on `costReportsTable` (mirrors the same read-only grant
      `get_report`/`get_prior_reports` already have on the agent-worker task role).
- [x] Tests: `handler.test.ts` — rewrote the analysis-formatting tests for the new shape (no more
      status/confidence/limitations in the output), added a driver-null-falls-back-to-summary case,
      and a breakdown-line-renders-correctly case using the real `PACO - Production` numbers from the
      live test as a fixture.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 103/103 tests across 23 files. `pnpm cdk:synth --context environment=staging --context
account=025031850414 --context region=eu-west-2` synthesizes cleanly; confirmed directly in the
synthesized `CostAgent-staging-Harness` template that `NotifySlackFunction` now has the
`COST_REPORTS_TABLE` env var wired to the real table export. **Not yet deployed or live-tested** —
next step is another `pnpm cdk:deploy CostAgent-staging-Harness ...` and a repeat of the
forward-message live test to see the new format and confirm the message-splitting fix actually
prevents truncation on a long analysis.

## Reverted test channel back to production (2026-09-28)

- [x] `config/harness.yaml`'s `staging.slack.channelId` changed back `C0B2Q9SE7S5` → `C0AQGLUN2Q6`
      (the real channel `paco-daily-cost-report` posts to), now that the sandbox-channel end-to-end
      test above succeeded. Comment updated to drop the "TEMPORARY" framing.
- [x] Verified: `pnpm test` still 103/103 green, `pnpm cdk:synth --context environment=staging
--context account=025031850414 --context region=eu-west-2` synthesizes cleanly, and the
      synthesized `CostAgent-staging-Harness` template confirms `NotifySlackFunction`'s
      `SLACK_CHANNEL_ID` is now `C0AQGLUN2Q6`.
- [ ] **Not yet deployed.** This revert needs to go out together with (or before/after, order doesn't
      matter functionally) the message-format + truncation-fix changes above — both are currently
      unstaged in the same `Harness` stack. Next real action: `pnpm cdk:deploy
CostAgent-staging-Harness --context environment=staging --context account=025031850414
--context region=eu-west-2`, then verify live in the **real** `C0AQGLUN2Q6` channel next time
      `paco-daily-cost-report` posts (or forward that day's message into the sandbox channel first if
      a lower-risk check is wanted before it goes live in production).

## Deployed to production channel + hit rate-limit/cache during retest (2026-09-28)

Deployed and confirmed live: `SLACK_CHANNEL_ID=C0AQGLUN2Q6`, `COST_REPORTS_TABLE` wired. Checked the
real `#daily-cost-report` channel: the `2026-09-27` report already has 20 replies — both from the
earlier sandbox test and an apparent duplicate `app_mention` delivery (a real Slack retry, correctly
deduped by the coordination layer — only one investigation actually ran; the "rate-limited" ack was
the retry's own honest response, not a bug). Re-mentioning that same thread now would just hit
"investigated too recently, rate-limited" — the user asked to loosen this so testing isn't blocked.

**Two separate gates found, both global (no per-environment override) in `config/harness.yaml`:**

- `rateLimits.fullInvestigationMinIntervalSeconds` (900s/15min) — `packages/core/src/
cost-orchestration.ts`'s `coordinateCostInvestigation` calls `rateLimit.limiter.tryConsume(...)`,
  which re-reads the **live** config value each call (not baked into the stored item) — lowering it
  takes effect immediately for the next mention, no data needs clearing.
- `cache.analysisTtlSeconds` (21600s/6h) — `DynamoRepositories.getFreshCache` checks the requested
  line's `expiresAt` (baked into the item **at write time** from whatever TTL was configured then)
  against now. Lowering the config only affects newly-written entries — an already-cached line from
  before this change keeps its original 6h expiry regardless.

- [x] `config/harness.yaml` — `rateLimits.fullInvestigationMinIntervalSeconds` 900 → 15,
      `cache.analysisTtlSeconds` 21600 → 60. Both marked inline as TEMPORARY for active testing, with
      a revert reminder and the reasoning above (including that the cache change won't retroactively
      un-stick the already-cached `2026-09-27` lines).
- [x] `pnpm test` (config schema still validates), `pnpm cdk:diff --context environment=staging
--context account=025031850414 --context region=eu-west-2` — confirmed exactly 2 stacks affected:
      `Ingestion` (`RATE_LIMIT_MIN_INTERVAL_MS` 900000→15000 on `SlackEventsFunction`) and `Harness`
      (`ANALYSIS_CACHE_TTL_SECONDS` 21600→60 on `PersistResultFunction`, plus routine container-image
      digest bumps from the earlier code changes — same code, new bundle hash). `Monitoring`/`Config`/
      `Data` unaffected.
- [ ] **Not yet deployed.** Both stacks need it this time (rate limit lives in `Ingestion`, cache TTL
      in `Harness`):
      `    pnpm cdk:deploy CostAgent-staging-Ingestion --context environment=staging --context account=025031850414 --context region=eu-west-2
pnpm cdk:deploy CostAgent-staging-Harness --context environment=staging --context account=025031850414 --context region=eu-west-2`
- [ ] Because the existing `2026-09-27` cache entries won't be affected by the TTL change, recommended
      testing on a **different, not-yet-investigated** report date (e.g. `2026-09-26`, real
      incoming-webhook message already sitting unthreaded in `#daily-cost-report`) for the very next
      test, rather than re-mentioning `2026-09-27`.
- [ ] **Revert reminder:** once this testing pass is done, put `rateLimits
.fullInvestigationMinIntervalSeconds` back to 900 and `cache.analysisTtlSeconds` back to 21600,
      then redeploy `Ingestion`+`Harness` again — these are global settings and currently weaker than
      intended for whenever `prod` eventually gets deployed too.

## User reported "meaningless" result — diagnosed as stale cache-hit ack, not a fresh run (2026-09-29)

User pasted a Slack message they got after re-mentioning the `2026-09-27` thread (`Bedrock Nova Lite`
HYPOTHESIS_ONLY 70%, `PACO - Production` INSUFFICIENT_EVIDENCE 20%, no driver, no breakdown, no
`*Evidence checked:*`) and asked why the agent's answer had nothing meaningful in it.

**Diagnosis:** that message's shape is a one-for-one match for `formatDecision`'s cache-hit branch
(`apps/functions/slack-events/handler.ts:114-125`: `• <label> (<amounts>) — already investigated:
<status>, confidence <pct>%<driver>`), not `notify-slack`'s rich format. `2026-09-27` was already
investigated (the original first live test), so every `@mention` under that thread just replays the
stale cached `FinalCostAnalysis` from that first test — including its genuine `INSUFFICIENT_EVIDENCE`/
`TIME_WINDOW_DENIED` outcome — instead of running a fresh investigation. None of the day-over-day
breakdown/evidence-checked formatting work landed in what the user saw, because no fresh run ever
happened. This exactly matches the risk this file itself flagged earlier ("recommended testing on a
different, not-yet-investigated report date... rather than re-mentioning 2026-09-27").

**Ruled out as the cause (checked, not just asserted):** tool budget (`config/harness.yaml`
`investigation.maxTurns: 12`/`maxToolCalls: 20` — generous for one line), playbook routing (`decrease`
past the significance threshold routes to `GENERIC`, which has the full 8-tool evidence set, not a
narrowed one), and account resolution (`CostReportLine.accountId` is already resolved at parse time
from `config/account-map.yaml`, not something the model has to look up itself).

**User decision:** test on a fresh, not-yet-investigated report date next (bypasses the cache
entirely), and separately investigate the underlying `INSUFFICIENT_EVIDENCE`/20%-confidence
investigation quality once a fresh run's real evidence trail (the `*Evidence checked:*` recap) is
available to look at — not worth speculating further on a two-sessions-old stale result with no
inspectable evidence catalog (no AWS creds to the real account in this session).

- [x] **Superseded by the redesign below** — the user rejected the cache/rate-limit mechanism itself
      rather than just wanting to route around it once more, so this "test on a fresh date" plan was
      dropped in favor of removing the mechanism entirely.

## Removed cache short-circuit and rate limiter; added "memory" the agent reads itself (2026-09-29)

Root-caused above: repeat `@mention`s of an already-investigated line never ran a fresh investigation
at all — they hit `formatDecision`'s cache-hit branch and replayed a stale `FinalCostAnalysis` verbatim.
User's explicit call: **"i dont want that kind of cache, we should maintain a local memory file and
agent will read it if already investigated before, not cached and do nothing like that"** — every
`@mention` must always trigger a real investigation; prior results become context the _agent_ reads,
not a harness-level skip. Follow-up question confirmed removing the rate limiter too: **"No, remove all
throttling"** — no minimum interval between investigations of the same line, at all. Judgment call made
along the way (not separately re-confirmed): kept `InvestigationLock`/`ConcurrencyBudget`, since those
guard against real simultaneous duplicate execution/capacity, not investigation recency — different
kind of check than what the user was rejecting.

- [x] `packages/core/src/cost-orchestration.ts` — removed `ExactAnalysisCache`/`RateLimiter`/
      `RateLimitBudget` entirely; `coordinateCostInvestigation` now only does lock + concurrency
      (no `cache`/`rateLimit` params, no `cacheHit`/`rateLimited` result fields).
- [x] `packages/aws-repositories/src/coordinate.ts` — same simplification for the real
      DynamoDB-backed `coordinateAndEnqueue` used by `slack-events`.
- [x] `packages/aws-repositories/src/dynamodb.ts` — repurposed `AnalysisCacheTable` as an
      unconditional memory slot: `ExactAnalysisCacheRecord` → `PriorAnalysisRecord`, `getFreshCache`
      (TTL-gated read) → `getPriorAnalysis` (plain read, no freshness check), `putCache`
      (write-once, `attribute_not_exists` condition) → `putPriorAnalysis` (plain overwrite). Deleted
      `DynamoRateLimiter` outright (now fully unused).
- [x] `apps/agent-worker/src/main.ts` + `packages/agent-sdk-runtime/src/prompt.ts` — the worker now
      calls `getPriorAnalysis(lineFingerprint)` before building its goal and passes the result into a
      new optional `CostGoalInput.priorAnalysis` field. `buildCostGoal` includes it in the
      `UNTRUSTED_COST_DATA` payload plus one guidance line telling the model it's a lead from a past
      run to confirm or revise with fresh evidence, never to repeat verbatim.
- [x] `apps/functions/persist-result/handler.ts` + `index.ts` — `cacheTtlSeconds`/`CacheWriter` →
      `memoryRetentionSeconds`/`MemoryWriter`; env var `ANALYSIS_CACHE_TTL_SECONDS` →
      `MEMORY_RETENTION_SECONDS`.
- [x] `apps/functions/slack-events/handler.ts` + `index.ts` — dropped the `cache`/`rateLimit` deps
      and the corresponding `formatDecision` reply branches (`already investigated: ...` and
      `rate-limited for now`); every notable line now only ever reports investigating/lock-contended/
      concurrency-throttled/not-started.
- [x] `config/harness.yaml` + `packages/config/src/harness-config.ts` — `cache.analysisTtlSeconds` →
      `memory.retentionSeconds` (kept at a 7-day default — bounds how long a prior analysis stays
      available as context and how long DynamoDB keeps the row via TTL, not a reuse window); deleted
      `rateLimits` entirely.
- [x] `apps/infra/lib/harness-state-machine.ts` + `apps/infra/lib/stacks.ts` + `apps/infra/bin/infra.ts`
      — renamed the `cache`/`rateLimitMinIntervalSeconds` config plumbing to `memory`, removed
      `RATE_LIMIT_MIN_INTERVAL_MS`/`rateLimitMinIntervalSeconds` throughout, added a `grantReadData`
      on `analysisCacheTable` for the ECS worker task role (new: the worker now reads its own prior
      analysis, previously only `persist-result` touched that table from the Harness side).
- [x] Updated tests to match: `cost-orchestration.test.ts` (dropped cache/rate-limit fakes and cases),
      `slack-events/handler.test.ts` (dropped cache-hit/rate-limited cases, replaced with a
      "still enqueues even when previously investigated" case), `persist-result/handler.test.ts`
      (renamed fixtures/fields).

**Verification:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` all
clean — 100/100 tests across 23 files. `pnpm cdk:synth --context environment=staging --context
account=025031850414 --context region=eu-west-2` synthesizes all 6 stacks cleanly (pre-existing subnet
route-table warnings only, unrelated to this change).

**Not yet done:**

- [ ] **Not yet deployed.** This touches both `Ingestion` (slack-events env vars/wiring) and `Harness`
      (persist-result, agent-worker, config shape) — needs `pnpm cdk:deploy CostAgent-staging-Ingestion`
      and `pnpm cdk:deploy CostAgent-staging-Harness` (same account/region context as above).
- [ ] **Not yet re-confirmed with the user:** the judgment call to keep the lock/concurrency guards
      while removing only the rate limiter, since "remove all throttling" could be read either way.
- [ ] No live Slack test yet of the new prior-analysis-as-context behavior — needs a real re-mention
      of an already-investigated line post-deploy to confirm the agent actually references (and
      doesn't just parrot) the prior conclusion, and that a fresh `*Evidence checked:*` section appears
      every time now instead of the old cache-hit one-liner.

## Slack message reduced to a pure per-service cost breakdown, no narrative (2026-09-29)

User's request (Vietnamese/English mix): "chỉ cần diễn giải tsao hqua mất từng này thôi / kiểu RDS mất
abc / ec2 mất abc / so với ngày hôm trước và hôm trc nữa / xem giá ntn / i just need this, no need the
per tool call message" — wants only a per-AWS-service cost breakdown vs. the day before and the day
before that, with no live per-tool-call progress messages at all. Confirmed via two `AskUserQuestion`s:
(1) message content is breakdown numbers only, no narrative/driver sentence — exact preview confirmed:

```
*PACO - Production* (2026-09-29)
Yesterday: $1,844.47  |  Day before: $2,133.02  |  2 days ago: $2,050.10

Breakdown by service (yesterday):
  • RDS: $612.30 (↑18%)
  • EC2: $540.20 (↓5%)
  • S3: $210.00 (flat)
  • Others: $481.97
```

(2) the per-service numbers still come from the agent's own tool-calling investigation (never a
separate deterministic Cost Explorer call bypassing the agent) — same evidence-anchoring discipline as
`estimatedMonthlySavingsUsd`.

- [x] Removed the live per-tool-call progress-message feature entirely: `apps/agent-worker/src/main.ts`
      (`SlackWebApiClient`, `buildEvidenceLink`/`EvidenceLinkContext`, `COST_TOOL_NAMES`,
      `toolCallDetail`, the `SLACK_CHANNEL_ID`/`SLACK_THREAD_TS` progress-posting block, and the
      `progress` field passed into `buildHarnessHooks`) and its CDK wiring in
      `apps/infra/lib/harness-state-machine.ts` (`SLACK_CHANNEL_ID`/`SLACK_THREAD_TS` ECS
      `containerOverrides`, `SLACK_SECRET_ARN` env var + secret grant on the worker task role,
      `EVIDENCE_BUCKET` env var + S3 read grant on `notifySlackFn`, `lineFingerprint` on the
      `NotifyAnalysisComplete` payload — all dead once the evidence-links/progress feature they served
      was removed).
- [x] `packages/schemas/src/cost-analysis.ts` — new `CostServiceBreakdownEntrySchema`
      (`service`, `yesterdayUsd`, optional `dayBeforeUsd`/`twoDaysAgoUsd`, required
      `supportingEvidenceIds`) and a required `serviceBreakdown: z.array(...).max(30)` field on
      `FinalCostAnalysisSchema` — numbers must be copied from a real `get_cost_and_usage` call grouped
      by SERVICE, never computed by the model.
- [x] `packages/core/src/cost-analysis-validation.ts` — `validateCostAnalysisEvidence` now drops any
      `serviceBreakdown` entry without a real supporting evidence ID, same pattern as the existing
      `estimatedMonthlySavingsUsd` stripping.
- [x] `packages/agent-sdk-runtime/src/prompt.ts` — `COST_SYSTEM_PROMPT` now instructs the model to
      always call `get_cost_and_usage` grouped by SERVICE/DAILY for the report date plus the two days
      before it, and copy the totals verbatim into `serviceBreakdown` with evidence IDs.
      `packages/agent-sdk-runtime/src/runner.ts`'s `partialAnalysis()` fallback gained
      `serviceBreakdown: []`.
- [x] `apps/functions/notify-slack/handler.ts` — rewritten: dropped the narrative/driver line, the
      status/confidence header, and the `*Evidence checked:*` section entirely; kept savings
      recommendations. New `formatServiceBreakdown` (top 5 services by `yesterdayUsd` descending +
      an `Others` bucket for the dollar remainder) and `formatPercentChange`
      (`↑N%`/`↓N%`/`(flat)`/`(new)`, comparing `yesterdayUsd` to `dayBeforeUsd`).
- [x] `apps/functions/notify-slack/index.ts` — `loadDayOverDayBreakdown` now fetches 3 days (today's
      report plus the prior 2 calendar days' reports) instead of 2, via a new
      `twoDaysBeforeCalendarDate` helper; dropped the now-unused S3 evidence-catalog loading
      (`S3EvidenceCatalog`, `loadEvidenceLinks`, `EVIDENCE_BUCKET`) entirely.
- [x] Updated every existing `FinalCostAnalysis` fixture across the repo to add `serviceBreakdown: []`
      (found via `grep -rln "rejectedHypotheses"`): `packages/agent-sdk-runtime/src/runner.ts` (prod
      fallback, not a test) plus `handler.test.ts` (notify-slack, persist-result), `validate-analysis/
handler.test.ts`, `cost-analysis-validation.test.ts`. Added new tests: `notify-slack/handler.test.ts`
      (breakdown-only rendering, per-service breakdown with percent change + Others bucket, no-breakdown
      omission cases) and `cost-analysis-validation.test.ts` (drops/keeps a `serviceBreakdown` entry
      based on evidence-ID validity).

**Deliberate scope decision, not re-confirmed with the user:** left the broader `slackChannel`/
`slackThreadTs` plumbing in place (Slack mention → SQS `DispatchMessage` →
`packages/aws-repositories/src/sqs.ts`/`coordinate.ts` → Step Functions execution input) even though
those fields become fully unused once the ECS `containerOverrides` that read them are removed. Ripping
that out would cascade into `apps/functions/dispatch/handler.ts` and `apps/functions/slack-events/
handler.ts` plus their tests — a materially larger change than what was asked for, and one that risks
destabilizing the just-completed memory/rate-limiter redesign above. Same category of open judgment
call as that redesign's lock/concurrency question.

Also not re-confirmed: keeping `savingsRecommendations` in the rendered message while dropping the
narrative/evidence-checked sections — the confirmed preview didn't explicitly address savings
recommendations either way; this was a unilateral call to keep them since they're still
evidence-anchored, actionable, and distinct from the narrative text the user objected to.

**Verification:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` all
clean — 101/101 tests across 23 files.

**Not yet done:**

- [ ] `pnpm cdk:synth --context environment=staging --context account=025031850414 --context
region=eu-west-2` — not yet re-run after this change to confirm all 6 stacks still synthesize cleanly
      with the removed env vars/grants/payload field.
- [ ] **Not yet deployed.** Touches `Harness` (agent-worker container env/image, `notifySlackFn` env/
      grants, state machine ASL payload).
- [ ] No live Slack test yet of the new breakdown-only message format — needs a real investigation
      post-deploy to confirm the rendered message matches the confirmed preview in production, and that
      dropping the live per-tool-call progress messages doesn't leave the channel silent for too long
      during a long-running investigation (no interim signal at all now between "Investigating…" and
      the final message).

## Brought back a one-line "why" driver — "the agent is the analyst, not the informer" (2026-09-29)

User pushed back immediately after the breakdown-only change above: numbers alone aren't enough, they
want the agent to explain _why_ the cost moved, not just report the delta. Confirmed placement via
`AskUserQuestion` — one short overall summary line above the numbers (not a per-service reason on every
bullet), exact preview confirmed:

```
*PACO - Production* (2026-09-29)
Main driver: RDS read IOPS spiked from a nightly batch job, partly offset by EC2 rightsizing.

Yesterday: $1,844.47  |  Day before: $2,133.02  |  2 days ago: $2,050.10

Breakdown by service (yesterday):
  • RDS: $612.30 (↑18%)
  • EC2: $540.20 (↓5%)
  • S3: $210.00 (flat)
  • Others: $481.97
```

- [x] `apps/functions/notify-slack/handler.ts` — new `formatDriverLine(analysis)`: renders
      `analysis.driver` (falling back to `summary` when `driver` is null) as `Main driver: <text>`,
      whitespace/newlines collapsed so it always renders as exactly one Slack line regardless of what
      the model sent. Inserted right after the `*<line>* (<date>)` title line, before the day-over-day
      numbers.
- [x] `packages/agent-sdk-runtime/src/prompt.ts` — `COST_SYSTEM_PROMPT` now tells the model `driver` is
      shown verbatim as that one Slack line, and to write one short causal sentence (the cause found,
      not a restatement of the numbers the breakdown already shows) — e.g. "rose because read IOPS
      spiked from a new nightly batch job", not "increased by 18% compared to yesterday".
- [x] No schema change — `driver`/`summary` already existed on `FinalCostAnalysisSchema`, unused by the
      Slack message since the breakdown-only pass above; this just puts them back in front of the user
      in a constrained, single-line form. No evidence-gating added either: `driver`/`summary` are
      narrative, not a numeric claim, same as before the breakdown-only pass — only `serviceBreakdown`
      and `estimatedMonthlySavingsUsd` are evidence-anchored by design.
- [x] Tests: `handler.test.ts` — renamed the narrative-dropping test to assert the driver line now
      renders (`Main driver: Increased token volume.`) while still asserting status/confidence/
      limitations/evidence-checked stay absent; added a driver-null-falls-back-to-summary case and a
      multi-line-driver-collapses-to-one-line case.

**Verification:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` all
clean — 103/103 tests across 23 files. `pnpm cdk:synth --context environment=staging --context
account=025031850414 --context region=eu-west-2` synthesizes all 6 stacks cleanly (this change touched
no infra wiring — Lambda code bundle only).

**Not yet done:** not yet deployed (same `Harness` deploy as the breakdown-only change above covers
this too — no separate deploy needed since neither has shipped yet); no live Slack test of the rendered
driver line yet.

## Real production bug: `error_during_execution` fallback shown as a fake "Main driver" (2026-09-29)

User saw a real Slack message reading `Main driver: The investigation ended without a valid
evidence-supported result. / Yesterday: $904.03` and asked what it was. Diagnosed from the text alone
first (this is `runner.ts`'s `partialAnalysis()` failure-fallback `summary`, not a real analysis —
`formatDriverLine` falls back to `summary` when `driver` is null, which is exactly this fallback's
shape). User then pasted live temporary AWS credentials and asked to check the logs so "it runs
properly" — read-only diagnosis only, no mutations made.

**Root-caused via the real Step Functions execution (`cost-da76b87fa4bd94813e01e6e4c912dc3a`,
`PACO - Production`, reportDate `2026-09-27`) and its ECS agent-worker's raw CloudWatch log stream —
two independent, compounding bugs, not one:**

1. **`serviceBreakdown` was a required schema field with no safe empty value.** The model queried
   `get_cost_and_usage` with `MONTHLY` granularity (not `DAILY` as the prompt asks), so it never had
   per-day-per-service figures to populate `serviceBreakdown` with. `FinalCostAnalysisSchema`
   (`packages/schemas/src/cost-analysis.ts`) had no `.default([])` on that field, so all **three**
   `submit_final_analysis` attempts in the log omitted the key and were rejected at the MCP layer with
   the identical zod error (`expected array, received undefined`) — an unrecoverable loop that burned
   the session's turn/budget limit with zero chance of ever succeeding.
2. **`runner.ts`'s read loop kept pulling from the SDK stream after its terminal message.** The log's
   last event shows the session correctly reached `{"event":"sdk_result_message","subtype":
"error_max_budget_usd",...}` — the real, accurate terminal state. But the persisted result recorded
   `terminalSubtype: "error_during_execution"` instead. Cause: `runAgentSession`'s `for (;;)` loop set
   `terminalSubtype` from the `result` message but never `break`s — it looped back to
   `iterator.next()` again, which threw (the stream has nothing left to yield), landed in the `catch`
   block, and since `proposed` was still `null` (bug 1 meant no answer was ever captured), the catch
   handler unconditionally overwrote the correct `error_max_budget_usd` with the generic
   `error_during_execution` — which is also why the user saw the non-budget fallback sentence ("ended
   without a valid evidence-supported result") instead of the budget one ("stopped at a configured
   budget limit").

**Fixes:**

- [x] `packages/schemas/src/cost-analysis.ts` — `serviceBreakdown: z.array(...).max(30).default([])`.
      A model with no daily-granularity evidence can now omit the field (or send `[]`) and still
      submit successfully; `validateCostAnalysisEvidence` and the Slack handler already handle an
      empty `serviceBreakdown` gracefully (both pre-date this fix).
- [x] `packages/agent-sdk-runtime/src/runner.ts` — added `break` immediately after processing a
      `result` message (the SDK stream's documented terminal message), so the loop never issues a
      post-terminal `iterator.next()` call that can throw and clobber the real `terminalSubtype`.
- [x] New tests: `packages/schemas/src/cost-analysis.test.ts` (omitted `serviceBreakdown` defaults to
      `[]` and parses successfully; an explicit array is still accepted). `packages/agent-sdk-runtime/
src/runner.test.ts` (new file — `runner.ts` had no tests before this) — a fake stream that yields a
      terminal `result` message and then throws on the next pull now correctly preserves
      `terminalSubtype`/`BUDGET_EXHAUSTED` instead of collapsing to `error_during_execution`/
      `INSUFFICIENT_EVIDENCE`; a control case confirms a stream that throws before any `result`
      message still correctly reports `error_during_execution`.

**Verification:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` all
clean — 107/107 tests across 25 files (up from 103/23).

**Not yet done:**

- [ ] **Not deployed.** This is a `Harness`-only Lambda/agent-worker code change (schema + runner
      logic, no infra wiring) — same `pnpm cdk:deploy CostAgent-staging-Harness --context
environment=staging --context account=025031850414 --context region=eu-west-2` already queued up
      for the two undeployed Slack-format changes above covers this too.
- [ ] The secondary anomaly flagged earlier — `get_cost_and_usage` returning `$0.00 total` for the
      account while the report line's real `yesterdayUsd` was `$904.03` — was **not** investigated
      further; the account-scoping/filter question there is independent of both bugs fixed here and
      still open.
- [ ] Whether the model reliably switches to `DAILY` granularity now that a missing `serviceBreakdown`
      no longer hard-fails the session is unverified — the schema fix makes the failure mode safe
      either way, but the prompt instruction to use `DAILY` granularity wasn't itself changed, so the
      breakdown may still come back empty on some runs until/unless that's separately confirmed live.

## Live retest: crash fixed, but per-service breakdown still empty — guided tool-level retry (2026-09-29)

After deploying (conceptually — see "not yet deployed" above) and passing all tests, the user pasted a
real Slack transcript of a colleague using the bot in production against a fresh report
(`PACO - Production`, reportDate `2026-09-27`). Good news: the crash from the previous incident is
gone — no more generic fallback boilerplate, and the bot posted a real narrative `Main driver` line and
savings recommendations. Bad news: the **original, very first feature request in this whole project** —
the per-service cost breakdown (RDS $X, EC2 $Y, ...) — still isn't rendering at all. Root cause is the
same one flagged as unverified above: the model still isn't reliably calling `get_cost_and_usage` with
`DAILY` granularity grouped by `SERVICE`, despite the prompt asking for it explicitly.

Presented three options via `AskUserQuestion` (guided tool-level retry / deterministic harness-side
fetch / prompt-only strengthening). **User picked "Guided tool-level retry"** — reject
`submit_final_analysis` once, with a corrective message, if it arrives with an empty `serviceBreakdown`
and no qualifying `get_cost_and_usage` call was ever attempted, rather than silently accepting the gap
or bypassing the model's own evidence-gathering (numbers must stay agent-sourced — same
evidence-anchoring principle as `estimatedMonthlySavingsUsd`).

**Fix — `packages/agent-sdk-runtime/src/tool-server.ts`:**

- [x] Added `isDailyServiceBreakdownAttempt(input)` — true when `granularity === 'DAILY'` and
      `groupBy` includes `'SERVICE'`. Deliberately keyed on _attempted_, not _succeeded_: a real
      `CONNECTOR_ERROR` on that call still counts, so a genuine AWS-side failure can't trap the model
      in an unwinnable retry loop — only whether it went looking matters.
- [x] `buildCostTools(dependencies)` now holds a closure-scoped `dailyServiceBreakdownAttempted` flag,
      set inside the `get_cost_and_usage` tool's handler wrapper. Confirmed via `grep` that
      `buildCostTools`/`buildCostToolServer` is constructed exactly once per investigation session
      (`apps/agent-worker/src/main.ts:227`), so this state is correctly scoped to a single session and
      never leaks across investigations.
- [x] `submitFinalAnalysisTool` (module-level const) became `buildSubmitFinalAnalysisTool(hasAttemptedDailyServiceBreakdown)`
      (a factory), so its handler can read that session's flag. If the submitted `serviceBreakdown` is
      empty and the flag is still `false`, the handler returns `isError: true` with a specific
      corrective message (call `get_cost_and_usage` with `granularity: "DAILY"` and `groupBy` including
      `"SERVICE"` for the report date and the two days before it, then resubmit) instead of the raw
      zod validation error from before. If the flag is `true` (a qualifying call was attempted, even if
      it failed) or `serviceBreakdown` is non-empty, the submission passes through unchanged.
- [x] New tests in `packages/agent-sdk-runtime/src/tool-server.test.ts` (4 cases): rejects an empty
      `serviceBreakdown` with no attempt made; accepts an empty `serviceBreakdown` once a DAILY/SERVICE
      call was attempted and failed; accepts a non-empty `serviceBreakdown` even without a prior
      attempt; confirms a `MONTHLY` call does **not** count as a qualifying attempt.

**Verification:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` all
clean — 111/111 tests across 25 files (up from 107/25).

**Not yet done / open risk:**

- [ ] **Not deployed** — same `Harness` deploy as above now also covers this change.
- [ ] **Unverified whether the model actually self-corrects on this guided error.** The prior incident
      showed the model did _not_ recover from a similarly clear-looking raw schema-validation error —
      it retried the identical failing call three times without changing its `get_cost_and_usage`
      granularity. This fix's message is more explicit and actionable than that raw zod error was, but
      that is a hypothesis, not a confirmed result — needs a live retest after deploy to confirm the
      per-service breakdown actually starts rendering, not just that the rejection message reaches the
      model.
- [ ] Secondary, lower-priority gaps noticed in the same transcript, not addressed by this fix: the
      `Main driver:` line rendered as a full paragraph rather than the "one short causal sentence" the
      prompt asks for; the Slack thread showed the "Parsed the ... cost report" acknowledgment three
      times in a row (likely a Slack event-retry/dedup artifact, not yet investigated).
- [ ] The secondary Cost Explorer anomaly (`get_cost_and_usage` returning `$0.00 total` while the
      report line's real `yesterdayUsd` was non-zero) remains open and uninvestigated.

## Rich root-cause Slack message: Conclusion + Cost comparison + Root cause evidence + Recommended actions (2026-09-30)

User provided 3 screenshots of a target message shape from a separate deep-investigation tool and said
"i want to update the message of the agent to be like this" — a narrative Conclusion paragraph, a
cost-source comparison (dashboard figure vs. a fresh Cost Explorer figure, flagging AWS's
late-arriving-usage backfill), a per-service breakdown, a **Root cause evidence** bullet list citing
specific signals (traffic multipliers, WAF/Lambda/Redshift/log metrics, a CloudTrail-attributed
who-changed-what-when event), and a numbered **Recommended actions** list. Confirmed via
`AskUserQuestion`: (1) target surface is Slack text/mrkdwn, not a real doc — multi-column tables become
`•` bulleted lines; (2) this is genuinely new evidence-gathering scope (no CloudTrail/WAF/CloudWatch-
metrics access existed at all before this); (3) this **replaces** the prior "Main driver: one sentence +
breakdown table + savings recs" format entirely, not layered alongside it. Full plan approved via
`ExitPlanMode` before implementation (`~/.claude/plans/clever-imagining-swan.md`).

**Scope-reduction decision made during planning:** every non-CloudTrail signal in the screenshots
(Lambda concurrency/invocations, API Gateway request counts, WAF allowed/blocked counts, Redshift
concurrency-scaling seconds, CloudWatch Logs volume) is just a plain CloudWatch metric — rather than 5
bespoke per-service connectors (each needing its own IAM actions and static config for ACL ARNs/cluster
IDs that don't exist anywhere today), **one generic CloudWatch metrics tool** (`list_cloudwatch_metrics`
for discovery, `get_cloudwatch_metric` for datapoints) covers all of them. Only the "who changed what,
when" signal (the Aurora reader-count change) genuinely needs a separate tool: CloudTrail
`lookup_events`. This kept the new evidence surface to **2 new AWS APIs** instead of 5.

- [x] `packages/cost-connectors/src/cloudwatch.ts` (new) — `CloudWatchConnector` (`listMetrics`,
      `getMetricData`), same thin-wrapper shape as `ResourceDescribeConnector`, throws
      `CLOUDWATCH_CONNECTOR_DISABLED` if not provisioned for an account.
- [x] `packages/cost-connectors/src/cloudtrail.ts` (new) — `CloudTrailConnector` (`lookupEvents`, loops
      over up to 5 `lookupAttributes` and merges results), throws `CLOUDTRAIL_CONNECTOR_DISABLED` if
      absent.
- [x] `packages/cost-connectors/src/resource-describe.ts` + `cross-account.ts` — `AccountClients`
      gained optional `cloudwatch`/`cloudtrail` fields; `buildCrossAccountClientFactory` now also
      builds `CloudWatchClient`/`CloudTrailClient` from the same assumed `PacoCostAgentReadOnly`
      credentials.
- [x] `packages/schemas/src/cost-tools.ts` — 3 new `CostToolName`s (`list_cloudwatch_metrics`,
      `get_cloudwatch_metric`, `get_cloudtrail_events`) + their input schemas.
- [x] `packages/schemas/src/cost-analysis.ts` — `CostEvidenceTypeSchema` gained `cloudwatch_metric`/
      `cloudtrail_event`; `FinalCostAnalysisSchema` gained `sourceDiscrepancy` (optional, whole-object
      evidence-gated), `rootCauseEvidence` (array, evidence-gated per entry, max 15), `recommendedActions`
      (array, evidence **optional** since these are advisory/process suggestions not numeric claims, max
      10).
- [x] `packages/cost-connectors/src/composed.ts` — `ComposedCostConnectorDependencies` gained required
      `cloudwatch`/`cloudtrail` fields; 3 new dispatch `case`s.
- [x] `packages/agent-sdk-runtime/src/tool-server.ts` — 3 new `tool(...)` entries, 3 new
      `buildEvidenceLink` cases (command-only, no console URL — same conservative choice as the existing
      Cost Explorer tools), 3 new `EVIDENCE_TYPE_BY_TOOL` entries.
- [x] `apps/agent-worker/src/main.ts` — constructs `CloudWatchConnector`/`CloudTrailConnector` from the
      existing cross-account client factory, wires into `buildComposedCostConnector`.
- [x] `packages/core/src/cost-analysis-validation.ts` — `rootCauseEvidence` whole-entry-drop filter
      (same pattern as `serviceBreakdown`); `sourceDiscrepancy` whole-object-drop when its
      `supportingEvidenceIds` don't resolve (implemented via explicit `delete` post-construction, not a
      conditional spread, to respect `exactOptionalPropertyTypes: true` without an unused-var lint
      violation — see lessons below); `recommendedActions` passed through unevidenced by design.
- [x] `packages/agent-sdk-runtime/src/prompt.ts` — loosened the driver-line "exactly one short sentence"
      constraint to "a short paragraph (2-4 sentences) when the root cause needs that much specificity"
      (supersedes the 2026-09-29 "one causal sentence" instruction per the user's explicit replace
      decision); added guidance on using the 2 new tools and populating `rootCauseEvidence`/
      `recommendedActions`/`sourceDiscrepancy`.
- [x] `apps/functions/notify-slack/handler.ts` — rewrote the `'analysis'` case: Conclusion paragraph →
      Cost comparison (dashboard snapshot bullet + optional Cost Explorer/discrepancy bullet) →
      Breakdown by service (unchanged) → Root cause evidence bullets → Recommended actions (numbered,
      literal `1. `/`2. ` text since Slack mrkdwn has no auto-numbering) → Savings recommendations
      (unchanged). Old `formatDriverLine`/`formatBreakdownLine` replaced by `formatConclusion`/
      `formatCostComparison`; new `formatRootCauseEvidence`/`formatRecommendedActions`.
- [x] `cross-account-role/permissions-policy.json` — added `cloudwatch:ListMetrics`,
      `cloudwatch:GetMetricData`, `cloudtrail:LookupEvents` to the single statement.
- [x] `config/harness.yaml`, `config/playbooks.yaml` — 3 new tool names added to
      `agentSdk.enabledMcpTools` and the `GENERIC` playbook's `enabledTools` (deliberately not added to
      `NEW_SERVICE_OR_USAGE_TYPE`, which stays narrower by existing design).
- [x] New tests: `cloudwatch.test.ts`, `cloudtrail.test.ts` (new files, one case per method + a
      `*_CONNECTOR_DISABLED` case each); `composed.test.ts` (3 new dispatch cases for the new tools, plus
      stand-in `{} as CloudWatchConnector`/`{} as CloudTrailConnector` added to the 4 pre-existing test
      calls now that those fields are required); `tool-server.test.ts` (3 new `buildEvidenceLink` command
      assertions + 3 new dispatch tests); `cost-analysis.test.ts` (new-field parse/default/reject cases
      for all 3 new schema pieces); `cost-analysis-validation.test.ts` (5 new drop/keep cases);
      `notify-slack/handler.test.ts` (rewritten — conclusion paragraph, cost-comparison-with/without-
      discrepancy, root-cause-evidence bullets, numbered recommended actions); every existing
      `FinalCostAnalysis` fixture repo-wide updated with `rootCauseEvidence: []`/`recommendedActions: []`.

**Lesson learned this session (added to avoid repeating):** when an optional object field must be
"dropped if unsupported" under `exactOptionalPropertyTypes: true` _and_ a strict-lint config with no
`varsIgnorePattern`, don't reach for `{ ...input, ...(valid ? { field } : {}) }` (the empty-object branch
is a no-op, so an invalid value already present from `...input` silently survives) and don't reach for
destructuring it out into an intentionally-unused variable (fails `@typescript-eslint/no-unused-vars`
with no ignore pattern configured). Instead build the object omitting that key from its own literal, then
`if (valid) obj.field = value; else delete obj.field;` immediately after — this is the only approach that
is simultaneously correct or every input shape and satisfies both constraints.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 141/141 tests across 27 files (up from 111/25). `pnpm cdk:synth --context environment=staging
--context account=025031850414 --context region=eu-west-2` synthesizes all 6 stacks cleanly (Lambda/
worker code-bundle change only — no new IAM/env-var wiring needed on the management-account side, since
the new permissions are entirely on the cross-account role).

**Not yet done — manual steps outside this environment:**

- [ ] **Re-apply `cross-account-role/permissions-policy.json`** via `aws iam put-role-policy` in both
      PACO-Production (`510825518696`) and PACO-Non-Production (`680099409919`) — Claude Code's own
      permission system blocks `iam:PutRolePolicy`, same limitation hit for this role's original
      creation.
- [ ] **Not deployed.** `pnpm cdk:deploy CostAgent-staging-Harness --context environment=staging
--context account=025031850414 --context region=eu-west-2`.
- [ ] **No live Slack test yet.** Needs the same forward-message-into-sandbox-channel pattern used
      previously (`C0B2Q9SE7S5`) to confirm the new sections render correctly in real Slack (multi-
      sentence Conclusion, `•` bulleted rows, numbered Recommended actions) and that a long message
      still splits cleanly across posts via the existing `splitForSlack`.

## First live end-to-end retest of the rich-message format — real bugs found (2026-09-30)

Deployed and re-mentioned the bot in `#daily-cost-report` on the 2026-09-29 report. Good: the crash from
the earlier `serviceBreakdown`/`error_during_execution` incident stayed fixed. Bad, found live: (1) the
per-line coordination-status text ("already being investigated" / "too many investigations running right
now, try again shortly") leaks into the user-facing ack as literal spam — 2 of 5 lines got starved out
by the concurrency budget and never got investigated at all; (2) with 5 notable lines the thread got 10+
separate bot messages (one "Investigating…" + one final analysis per line); (3) the rendered analyses
still read as raw reasoning/math ("The 10.6% down trend is exactly ($279.33-$249.65)/$279.33...") rather
than a plain-English conclusion. User's verdict (their words): "the result not good, i dont need the
'reasoning' in the saving agent, plust i just need ONE final investigation."

Confirmed scope via two `AskUserQuestion`s: (1) **one consolidated Slack message per report** — still
investigate every notable line, but fan-in all results into a single final message instead of one per
line (fixes the throttle-status spam too, since per-line progress messages go away entirely); (2) **drop
the Root cause evidence section** from the rendered message entirely, and make the driver/Conclusion
narrative itself terser — plain-English cause only, no percentage-math or methodology sentences. Full
plan approved via `ExitPlanMode` before implementation (`~/.claude/plans/zany-humming-hickey.md`).

**Design:** fan-out (per-line lock/concurrency/SQS/Step-Functions-execution) is unchanged. Fan-in via one
new atomic DynamoDB item per report round (`BATCH#{reportDate}#{sourceEventId}` in ControlTable, same
single-table `controlKey`-prefix pattern as `LOCK#`/`CONC#`/`SLACK#`): every terminal Lambda
(`persist-result` on success, `handle-failure` on any failure) calls one atomic `UpdateCommand`
(`ADD` counter + `list_append` + a fingerprint-Set dedupe condition, `ReturnValues: 'ALL_NEW'`) exactly
once per line; DynamoDB serializes concurrent updates to one item, so exactly one caller's own response
ever observes `completedCount === expectedCount` — only that caller posts the one consolidated message.
`expectedCount` is fixed at batch-creation time to lines _actually enqueued_ this round (excludes
throttled/contended lines); zero-enqueued rounds create no batch at all.

- [x] `packages/aws-repositories/src/dynamodb.ts` — new `DynamoBatchTracker` class (`createBatch`,
      `contribute`), `BatchLineResult`/`BatchRecord`/`BatchContribution` types. `DynamoCommandClient`
      widened to include `Attributes?` (needed for `UpdateCommand`'s `ReturnValues: 'ALL_NEW'`).
- [x] `packages/aws-repositories/src/coordinate.ts` — split `coordinateAndEnqueue` into a decide-pass
      (unchanged lock/concurrency logic, no publish) and a publish-pass (create batch if
      `enqueued.length > 0`, then publish each line with `batchId`/`expectedCount` attached). New
      `AsyncBatchCreator` interface; `InvestigationQueuePublisher.publish` gains
      `batchId`/`expectedCount`. `enqueued` narrowed via a type-predicate `.filter()` (not an
      assertion — this repo's lint forbids both `as string` and `!`).
- [x] `packages/aws-repositories/src/sqs.ts` — `SqsInvestigationPublisher.publish` message type gains
      `batchId`/`expectedCount`.
- [x] `apps/functions/dispatch/handler.ts` — `DispatchMessage` gains `batchId`/`expectedCount`.
- [x] `apps/functions/persist-result/handler.ts` + `index.ts` — `PersistResultInput` gains
      `lineLabel`/`batchId`/`expectedCount`; contributes `status: 'completed'` to the batch; returns
      `{persisted, batchComplete, batch?}`. New `BatchContributor` interface.
- [x] `apps/functions/handle-failure/handler.ts` + `index.ts` — same treatment, contributes
      `status: 'failed'` — the piece that stops one failed line from hanging the batch forever.
- [x] `apps/functions/notify-slack/handler.ts` — removed `'started'`/`'analysis'` kinds and
      `formatRootCauseEvidence`'s call site; added `kind: 'report_complete'` rendering every line's
      section (reusing `formatConclusion`/`formatCostComparison`/`formatServiceBreakdown`/
      `formatRecommendedActions`/`formatSavingsRecommendation` unchanged) joined under one header,
      reusing `splitForSlack`/`notifySlack` as-is.
- [x] `apps/functions/notify-slack/index.ts` — enriches each completed line by reading its analysis back
      from `AnalysisCacheTable` (new `getPriorAnalysis` helper) + the existing
      `loadDayOverDayBreakdown`. New `ANALYSIS_CACHE_TABLE` env var.
- [x] `apps/functions/slack-events/handler.ts` + `index.ts` — wired `batches`/`batchTtlMs`; rewrote
      `formatReply` to drop per-line lock/concurrency status text, naming only the enqueued lines plus
      one aggregate skipped-count note. Deleted now-dead `formatDecision`/`formatAmounts`/`trendText`/
      `formatUsd` and their now-unused `classifySignificance`/`CostReportLine` imports.
- [x] `apps/infra/lib/harness-state-machine.ts` — removed `notifyInvestigationStarted` and the per-line
      `notifyAnalysisComplete` invoke; `notifySlackFn` gains `ANALYSIS_CACHE_TABLE` env var + read
      grant; threaded `lineLabel`/`batchId`/`expectedCount` into every terminal Lambda's `TaskInput`;
      standardized `resultPath` to `$.completion`; new `finishExecution(id, terminal)` Choice helper
      gating a `NotifyReportComplete` invoke on `$.completion.batchComplete`, wired into all four
      terminal branches. **Two real bugs caught by `cdk:synth` (ASL graph errors, not caught by
      typecheck/tests) and fixed before landing:** (1) a single shared `NotifyReportComplete`/
      `BranchOnBatchCompletion` construct can't have `.next()` called on it from 4 different call sites
      with 4 different terminals — Step Functions states carry exactly one `Next`; fixed by making
      `buildNotifyReportComplete(id)` a factory building a fresh construct (unique CDK id) per call
      site. (2) `failMissingReport` is one shared state reused by both `REPORT_NOT_FOUND` and
      `LINE_NOT_FOUND` — calling `.next()` on it twice (once per condition) silently let the second
      call overwrite the first; fixed by calling `.next()` on it exactly once and referencing the same
      object from both `Choice.when()` branches, matching how it already worked pre-change.
- [x] `packages/agent-sdk-runtime/src/prompt.ts` — tightened the `driver`-field instruction to one or
      two plain-English sentences naming the cause only, explicitly forbidding percentage/dollar
      arithmetic or methodology narration. `rootCauseEvidence`-population instruction left unchanged
      (still gathered; only the Slack rendering drops it). `SYSTEM_PROMPT_VERSION` bumped
      `cost-agent-system-v1` → `v2` (grepped first — nothing else references the literal).
- [x] Tests: updated `persist-result`/`handle-failure`/`notify-slack`/`slack-events`/`dispatch` handler
      tests for the new fields/behavior (including new cases: last-contribution-returns-full-batch,
      expectedCount-excludes-a-lock-contended-line, no-batch-when-everything-throttled); new
      `packages/aws-repositories/src/batch.test.ts` (3 tests) covering the fan-in "last one home"
      logic, dedupe-on-redelivery, and idempotent `createBatch`, against a hand-rolled fake
      `DynamoCommandClient` that mimics DynamoDB's conditional-write semantics for exactly the two
      commands `DynamoBatchTracker` issues.
- [x] Verification: `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
      clean — 149/149 tests across 28 files (up from 141/27). `pnpm cdk:synth --context
environment=staging --context account=025031850414 --context region=eu-west-2` synthesizes all 6
      stacks cleanly; the synthesized `Harness` template was inspected directly to confirm
      `NotifyInvestigationStarted`/`NotifyAnalysisComplete` are gone, 4 `NotifyReportComplete`/
      `BranchOnBatchCompletion` state pairs exist (one per terminal branch), and `NotifySlackFunction`
      has the `ANALYSIS_CACHE_TABLE` env var wired to the real table export; the synthesized
      `Ingestion` template confirms `SlackEventsFunction`'s `BATCH_TTL_MS` (960000ms, from
      `max(lockTtlSeconds, taskTimeoutSeconds + 300) * 1000`) alongside the existing `LOCK_TTL_MS`
      (300000ms).

**Not yet done:**

- [ ] **Not deployed.** Touches `Harness` (state machine, persist-result, handle-failure, notify-slack,
      agent-worker prompt) and `Ingestion` (slack-events, for `batches`/`BATCH_TTL_MS`) —
      needs `pnpm cdk:deploy CostAgent-staging-Ingestion` and `pnpm cdk:deploy
CostAgent-staging-Harness` (same account/region context as above).
- [ ] **No live Slack test yet.** Needs a report with 2+ notable lines re-mentioned post-deploy to
      confirm: exactly one consolidated message arrives (not one per line), no
      "already being investigated"/"too many investigations running" text leaks into the ack, the
      Conclusion line reads as plain English with no percentage-math, and there is no "Root cause
      evidence:" section anywhere in the rendered message.

## Two more corrections before first deploy: bring Root cause evidence back, stop duplicate acks (2026-09-30)

Before the above ever got deployed, the user pushed back twice more in quick succession, both resolved
without deploying yet (so this folds into the same not-yet-deployed `Harness`/`Ingestion` change above,
not a separate deploy).

**1. Root cause evidence should NOT have been dropped.** User posted 3 screenshots of the target format
(Conclusion, Cost view, Primary cost drivers, **Root cause evidence**, Recommended actions — the same
shape from the 2026-09-30 "Rich root-cause Slack message" work earlier today) and said "the result final
result in this format." Confirmed via `AskUserQuestion` this reverses the "drop reasoning" decision from
two sessions ago in this same file — the terser plain-English Conclusion stays (that part was correct),
but the Root cause evidence bullets come back.

- [x] `apps/functions/notify-slack/handler.ts` — re-added `formatRootCauseEvidence` (unchanged from
      before it was deleted) and wired it back into `formatCompletedLine`, between Breakdown by service
      and Recommended actions (matching the confirmed screenshot order).
- [x] Tests: `notify-slack/handler.test.ts` — flipped the "drops root-cause-evidence" assertion to
      assert it's present, added a dedicated omit-when-empty case.

**2. The "Investigating…" ack was posting 2-3x per mention — a real, previously-flagged-but-unaddressed
bug, not the consolidation working as intended.** User pasted a live transcript showing the identical ack
three times within a minute. Root cause: Slack redelivers the identical `app_mention` event (same
`event.ts`) when the Lambda doesn't ack within Slack's 3-second window; `upsertReport`'s own
`IDEMPOTENCY#slack:{sourceEventId}` transactional key already detects this exact case and returns
`{duplicate: true}` — but `handleSlackEvent` never checked that return value, so every retry re-ran the
whole handler including the ack post. This is the same anomaly flagged-but-not-investigated in the
2026-09-29 "guided tool-level retry" entry above ("the Slack thread showed the ... acknowledgment three
times in a row (likely a Slack event-retry/dedup artifact, not yet investigated)") — now actually fixed.

- [x] `apps/functions/slack-events/handler.ts` — capture `upsertReport`'s return value; skip only the
      `postMessage` ack when `duplicate` is true. `claimThread`/`coordinateAndEnqueue` still run
      unconditionally on every delivery (both are already safe to repeat — lock reacquire-by-same-owner
      and Step Functions execution-name collisions are both no-ops) so a genuine crash between
      `upsertReport` succeeding and the rest of the handler completing doesn't silently drop the round;
      only the redundant Slack post is suppressed.
- [x] Tests: `slack-events/handler.test.ts` — `fakeDeps` gained an `upsertDuplicate` override; new case
      asserts `postMessage` is not called (but `claimThread`/`publish` still are) when `upsertReport`
      reports a duplicate delivery.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 151/151 tests across 28 files (up from 149/28). `pnpm cdk:synth --context environment=staging
--context account=025031850414 --context region=eu-west-2` synthesizes all 6 stacks cleanly (Lambda
code-bundle changes only, no infra wiring touched by either fix).

## Temporary exclusion list: stop investigating "Bedrock Nova Lite" (2026-09-30)

User asked "does it check for all account?" (answered: yes — the 3 configured accounts in
`config/account-map.yaml` all get investigated when notable; "Total AWS" is the org-wide aggregate;
"Bedrock Nova Lite" has no `accountId` at all — `cost-message-parser.ts` only resolves one when
`forecastUsd` is present, and Bedrock's report line never has one, so it's parsed as `kind: 'service'`)
then "temporary ignore the bedrock please" — Bedrock Nova Lite has read `$0.00 (new)` on every report for
weeks (visible across many pasted transcripts in this file), permanently classified `isNotable` because
`trend.direction === 'new'` is an unconditional true regardless of magnitude — burning one investigation
slot per report for zero value and contributing to the "2 lines skipped — at capacity" starvation seen in
the same live transcript.

- [x] `packages/core/src/cost-playbook.ts` — `CostSignificanceThresholds` gained optional
      `excludedLabels?: readonly string[]`; `isNotable` checks it first, before the new/percent checks.
- [x] `packages/config/src/harness-config.ts` — `significance.excludedLabels: z.array(z.string().min(1)).default([])`.
- [x] `config/harness.yaml` — `significance.excludedLabels: ['Bedrock Nova Lite']`, marked TEMPORARY
      with an inline revert condition (once Bedrock accrues real spend or is confirmed decommissioned).
      This is a top-level (not per-environment) block, same as `significantChangePercent` already was —
      applies to dev/staging/prod alike.
- [x] `apps/infra/lib/stacks.ts` — `IngestionStackProps` gained `excludedLabels: string[]`; new
      `EXCLUDED_LABELS_JSON` env var on `slackEventsFn`.
- [x] `apps/infra/bin/infra.ts` — passes `harnessConfig.significance.excludedLabels` through.
- [x] `apps/functions/slack-events/index.ts` — `thresholds.excludedLabels` parsed from
      `EXCLUDED_LABELS_JSON`.
- [x] Tests: `cost-playbook.test.ts` — new case confirms an excluded label is never notable even when
      brand new or far over threshold, and that other labels are unaffected.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 152/152 tests across 28 files. `pnpm cdk:synth` (all 6 stacks) confirms the synthesized
`Ingestion` template has `EXCLUDED_LABELS_JSON: '["Bedrock Nova Lite"]'` on `SlackEventsFunction`.
**Not yet deployed** — folds into the same pending `Ingestion` deploy above.

## Merge N per-line reports into ONE report per message, not N full reports stitched together (2026-09-30)

Live test of the batch-consolidation work above showed the fan-in mechanism itself working correctly
(one ack, one final message, no duplicate "Investigating…" spam) — but the ONE final message still
contained a full, separate "Conclusion / Cost comparison / Breakdown / Root cause evidence / Recommended
actions" block **per notable line**, joined by `---` dividers (e.g. a full report for `Total AWS`, then
another full report for `Blinx - Management Account`, then another for `Bedrock Nova Lite`). User: "i just
need ONE conclusion for all AWS env please, no need repeate the report for each account like this."

Presented three options via `AskUserQuestion` (mechanical merge / one synthesized-by-AI investigation /
true single investigation from the start). **User picked mechanical merge** — no new AI call. Confirmed
design: per-line evidence gathering stays exactly as-is (each notable line still gets its own independent
Step Functions execution and its own Cost Explorer/CloudWatch/CloudTrail evidence), but the final message
now has **one Conclusion section, one Cost comparison section, one Breakdown section, one Root cause
evidence section, one Recommended actions section, one Savings recommendations section** — each
containing one bullet per line, not one full report per line. Sums are never taken across lines (e.g.
"Total AWS" already includes "Blinx - Management Account", so adding their service-breakdown dollar
figures together would double-count) — each bullet just carries its own line's real number, labeled with
which account/line it came from (`[Total AWS] RDS: $718.60 (↑97%)`).

- [x] `apps/functions/notify-slack/handler.ts` — deleted the old per-line whole-section formatters
      (`formatCostComparison`, `formatServiceBreakdown`, `formatRootCauseEvidence`,
      `formatRecommendedActions`, `formatSavingsRecommendation`, `formatCompletedLine`,
      `formatFailedLine`) and replaced them with `formatMergedConclusion`/`formatMergedCostComparison`/
      `formatMergedBreakdown`/`formatMergedRootCauseEvidence`/`formatMergedRecommendedActions`/
      `formatMergedSavingsRecommendations` — each takes the full `lines: ReportCompleteLine[]` array and
      produces exactly one section, `flatMap`-ing/labeling bullets per line rather than nesting a
      subsection per line. `formatNotification`'s `report_complete` case now builds these six sections
      once and joins only the non-empty ones. Header simplified to `Cost report {date}` (dropped the
      redundant "N lines investigated" — the Conclusion section now says exactly which lines and how).
- [x] Tests: fully rewrote `notify-slack/handler.test.ts`'s `formatNotification` describe block for the
      merged shape — one case per section confirming (a) the section header appears exactly once even
      with 2+ lines contributing to it, (b) each bullet is correctly labeled/prefixed, (c) sections with
      no contributing lines are omitted entirely, (d) recommended-actions numbering is global across
      lines, not restarted per line. `notifySlack`'s long-message split test switched from two
      `mockResolvedValueOnce` calls to a counter-based `mockImplementation`, since the merged single
      report needs more lines to exceed the chunk limit than before, and the exact resulting chunk count
      is no longer a hardcoded assumption worth pinning down (the split behavior itself, not the count,
      is what's under test).

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 152/152 tests across 28 files (same total as before — this was a like-for-like test rewrite, not
new coverage). `pnpm cdk:synth` (all 6 stacks) synthesizes cleanly — Lambda code-bundle change only, no
infra wiring touched. **Not yet deployed** — folds into the same pending `Ingestion`+`Harness` deploy
above; nothing in this repo has been deployed since the very first `Harness`/`Ingestion` deploy days ago,
so all of today's session's changes (fan-in consolidation, Root cause evidence restoration, duplicate-ack
fix, Bedrock exclusion, and this merge) ship together in one deploy.

## Cut down to exactly 3 sections: Conclusion, Breakdown by service, Recommended actions (2026-09-30)

User, reacting to the just-built 6-section merge above still being too much: "i just need the WHY the
cost increase compare to the last day (already in the message to slack) and cost break down to the
service, and recommendataion, keep it short, clear and forcus please." No further clarifying question
asked this time — the request was concrete and the user had already signaled frustration with too much
back-and-forth ("dont make it too complicated").

- [x] `apps/functions/notify-slack/handler.ts` — deleted `formatMergedCostComparison` and
      `formatMergedRootCauseEvidence` and `formatMergedSavingsRecommendations` entirely (not just
      unwired — genuinely unused now, per this repo's "delete, don't comment out" convention). The
      `report_complete` case now builds exactly 3 sections: `formatMergedConclusion` (the why, vs
      yesterday — already embedded in the model's own `driver` text per prompt.ts's existing
      instruction, no prompt change needed), `formatMergedBreakdown`, `formatMergedRecommendedActions`.
      `CostLineDayOverDay`/`breakdown` stay on `ReportCompleteLine` and get fetched exactly as before —
      still needed as the "Others" bucket denominator in `formatMergedBreakdown` — only the standalone
      "Cost comparison:" section that surfaced the dashboard-vs-Cost-Explorer discrepancy is gone.
      `sourceDiscrepancy`/`rootCauseEvidence`/`savingsRecommendations` stay on the schema and keep being
      gathered/validated exactly as before (same "computed but not rendered" pattern already established
      for `status`/`confidence`/`limitations`) — purely a rendering cut, no evidence-gathering change.
- [x] Tests: removed the cost-comparison and root-cause-evidence `formatNotification` cases, replaced
      with one case asserting none of the three dropped sections (or their content) ever render; the
      long-message-split test's padding source switched from `savingsRecommendations` (no longer
      rendered, so no longer useful for padding message length) to `recommendedActions`.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 147/147 tests across 28 files (down from 152 — net removal of dead-section test coverage, no
regressions). `pnpm cdk:synth` (all 6 stacks) synthesizes cleanly. **Not yet deployed** — folds into the
same pending deploy as everything else from today's session.

## Live investigation: why is PACO - Non-Production never investigated? (2026-09-30)

User, looking at a live consolidated ack ("Investigating 3 notable lines: ... (1 line skipped)"), asked
why `PACO - Non-Production` keeps getting left out. Read the full 29-reply live thread via the Slack MCP
tools to check: `PACO - Non-Production` had been stuck in "already being investigated or at capacity"
across **every mention since 20:11, still unresolved at 23:49** (~2.5 hours). First hypothesis (asked via
`AskUserQuestion`, not yet answered when the user redirected) was a leaked concurrency reservation — ruled
out once the real cause was found: **`concurrency.maxPerReportInvestigations: 3`** in `config/harness.yaml`.
This report consistently has 4 real notable lines (Total AWS, Blinx - Management Account,
PACO - Production, PACO - Non-Production, once Bedrock Nova Lite is excluded per the earlier fix) — lines
are processed in report order, so the first 3 always claim the capped slots and PACO - Non-Production,
always last in the report, never gets a turn. Not a bug/leak — a cap that was simply lower than this
report's real line count. `maxGlobalInvestigations: 5` had headroom, so raising the per-report cap was
safe. Confirmed via `AskUserQuestion`: **raise to 5** (matches the global cap, so the per-report cap stops
being a practical constraint at all, with room for a 5th account later without another config change).

- [x] `config/harness.yaml` — `concurrency.maxPerReportInvestigations` 3 → 5, with an inline comment
      explaining the starvation pattern this was causing.

**Verification:** `pnpm test && pnpm format:check` clean — 147/147 tests (pure config value, no code
touched `maxPerReportInvestigations` in any test fixture tied to the real YAML). `pnpm cdk:synth` (all 6
stacks) confirms `MAX_PER_REPORT_INVESTIGATIONS: "5"` on the synthesized `SlackEventsFunction`. **Not yet
deployed.**

## Bold the consolidated message's headline (2026-09-30)

User: "help me to use the headline to be bold." `apps/functions/notify-slack/handler.ts` — the
`report_complete` header changed from `` `Cost report ${date}` `` to `` `*Cost report ${date}*` `` (Slack
mrkdwn bold). Test updated to assert the first line is exactly `*Cost report 2026-09-24*`.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 147/147 tests across 28 files. `pnpm cdk:synth` (all 6 stacks) synthesizes cleanly — Lambda
code-bundle change only. **Not yet deployed** — folds into the same pending deploy as everything else
from today.

## Drop the Breakdown section, switch Conclusion/Recommended Actions to plain paragraphs (2026-10-01)

User pasted a target example (two plain headers, "Conclusion" and "Recommended Actions", each a run of
plain paragraphs with no bullet glyphs, brackets, or numbering) and asked to shorten the message to match
it. Implemented directly, no clarifying question, consistent with the user's established "don't make it
too complicated" preference from the prior round.

- [x] `apps/functions/notify-slack/handler.ts` — deleted `formatMergedBreakdown` and its now-unused
      helpers (`formatUsd`, `formatPercentChange`, `MAX_BREAKDOWN_SERVICES`) entirely — the "Breakdown by
      service" section is gone, not just unwired. `formatMergedConclusion`/`formatMergedRecommendedActions`
      dropped their ` •` bullet prefix and `[label]`/numbered-list formatting in favor of one plain
      `{label}: {text}` paragraph per line; section headers changed from `Conclusion:`/`Recommended
actions:` to plain `Conclusion`/`Recommended Actions` (no colon, matching the pasted example
      exactly). `report_complete` now renders exactly 2 sections instead of 3. `breakdown` removed from
      `ReportCompleteLine`/`CostLineDayOverDay` type deleted — both existed purely to feed the now-deleted
      section.
- [x] `apps/functions/notify-slack/index.ts` — deleted `loadDayOverDayBreakdown`, `getReportRecord`,
      `priorCalendarDate`/`twoDaysBeforeCalendarDate`, and the `COST_REPORTS_TABLE` env read — all were
      unused once nothing renders the breakdown. `enrichLine` now only re-reads `analysis` from
      `AnalysisCacheTable`.
- [x] `apps/infra/lib/harness-state-machine.ts` — removed `COST_REPORTS_TABLE` from `NotifySlackFunction`'s
      env and its `costReportsTable.grantReadData(notifySlackFn)` grant — that table access was only ever
      for the breakdown section.
- [x] `packages/schemas/src/cost-analysis.ts` — fixed a stale doc-comment reference to the now-deleted
      `CostLineDayOverDay` type on `CostServiceBreakdownEntrySchema`; the underlying `serviceBreakdown`
      evidence field itself is unchanged (still gathered/validated, same "computed but not rendered"
      pattern already established for `rootCauseEvidence`/`sourceDiscrepancy`).
- [x] Tests: removed the service-breakdown `formatNotification` case; updated the "never renders a ...
      section" case to also assert no "Breakdown by service" text; updated the Conclusion/Recommended
      Actions assertions for the new plain-paragraph, no-bullet, no-bracket format.

**Verification:** `pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` all
clean — 146/146 tests across 28 files (net -1: the dedicated breakdown-merge test was removed, not
replaced, since the feature itself is gone). `pnpm cdk:synth` (all 6 stacks) synthesizes cleanly;
confirmed via the synthesized `CostAgent-staging-Harness` template that `NotifySlackFunction`'s env no
longer includes `COST_REPORTS_TABLE`. **Not yet deployed** — folds into the same pending deploy as
everything else from today.

## Current status & next step (as of 2026-10-01)

Everything built and tested cleanly all session (code-level only — nothing below has been deployed yet).
The final Slack message format, after the full 2026-09-29/09-30/10-01 iteration series, is now locked in
at:

```
*Cost report {date}*

Conclusion
{line}: {one-or-two-sentence plain-English why, vs yesterday}
{line}: ...

Recommended Actions
{line}: {action}
{line}: ...
```

One consolidated message per report round (fan-in via `DynamoBatchTracker`, "last one home" pattern —
see `## Consolidate per-line Slack spam into one final message per report`, 2026-09-30), posted once into
the report's single Slack thread. No per-line spam, no "Root cause evidence"/"Cost comparison"/"Breakdown
by service"/status/confidence sections — those are all still gathered and validated server-side
(`FinalCostAnalysisSchema`/`validateCostAnalysisEvidence` unchanged throughout), just never rendered to
Slack. `concurrency.maxPerReportInvestigations` is 5 (matches the global cap, so a report with up to 5
notable lines never starves one out). `significance.excludedLabels` temporarily excludes "Bedrock Nova
Lite" (revert condition documented inline in `config/harness.yaml`).

**Nothing explicitly pending from the user right now.** The one standing item across the whole session:
**none of today's changes are deployed.** Everything from 2026-09-30 onward (fan-in consolidation, Root
cause evidence restore + dropped again, duplicate-ack fix, Bedrock exclusion, the 3-section cut, the
`maxPerReportInvestigations` fix, the bold headline, and today's Breakdown-section removal) is still
sitting in the working tree only. Two commands cover all of it:

```bash
pnpm cdk:deploy CostAgent-staging-Ingestion --context environment=staging --context account=025031850414 --context region=eu-west-2
pnpm cdk:deploy CostAgent-staging-Harness --context environment=staging --context account=025031850414 --context region=eu-west-2
```

(`Ingestion` carries the `slack-events`/concurrency-config change; `Harness` carries the Step Functions
supervisor + `notify-slack` message-format change. Both are required for a live test to reflect
everything above.)

## Bold section headers + per-line trend icon (2026-10-01)

User ask: bold the "Conclusion"/"Recommended Actions" headers, and add an icon per line showing cost
trend — green for a down trend (good), red for an up trend (bad). Deliberately inverted from the usual
stock-chart emoji convention (📈 green-up/📉 red-down) since for a cost tracker, up is bad and down is
good — used explicit `:red_circle::arrow_up:` / `:large_green_circle::arrow_down:` combos instead.
`flat`/`new` trends get no icon (neither reads as clearly good or bad).

Message format is now:

```
*Cost report {date}*

*Conclusion*
{icon }{line}: {one-or-two-sentence plain-English why, vs yesterday}
{icon }{line}: ...

*Recommended Actions*
{line}: {action}
{line}: ...
```

Threaded a new `trendDirection: 'up'|'down'|'flat'|'new'` field end-to-end, sourced from
`CostReportLine.trend.direction` (the deterministic, parse-time-known trend from
`packages/core/src/cost-message-parser.ts` — not the evidence-gated `serviceBreakdown`, which isn't
reliably populated):

- `packages/aws-repositories/src/coordinate.ts` / `sqs.ts` — `InvestigationQueuePublisher`/
  `SqsInvestigationPublisher.publish()` now carry `trendDirection: CostReportTrend['direction']`.
- `apps/functions/dispatch/handler.ts` — `DispatchMessage` gained a required `trendDirection` field
  (always known at dispatch time); it's set once in the Step Functions execution input and re-read via
  `$.trendDirection` everywhere downstream, same pattern as `reportDate`/`lineLabel`/`batchId`.
- `apps/infra/lib/harness-state-machine.ts` — added `trendDirection: sfn.JsonPath.stringAt('$.trendDirection')`
  to all 4 `TaskInput.fromObject` call sites that invoke `persist-result`/`handle-failure`
  (`HandleWorkflowError`, `HandleMissingReport`, `HandleMissingWorkerResult`, `PersistAnalysis`).
- `apps/functions/persist-result/handler.ts` / `handle-failure/handler.ts` — `PersistResultInput`/
  `HandleFailureInput` gained an optional `trendDirection`, conditionally spread into the
  `BatchLineResult` entry passed to `batches.contribute(...)` (kept optional, not required, so the
  existing exact-match `toEqual`/`toHaveBeenCalledWith` test fixtures that omit it keep passing).
- `apps/functions/notify-slack/handler.ts` — `ReportCompleteLine` gained optional `trendDirection` on
  both variants; new `formatTrendIcon()` helper; wired into `formatMergedConclusion` so every
  Conclusion line (completed or failed) gets the icon prefix.
- `apps/functions/notify-slack/index.ts` — fixed a latent bug in `enrichLine()`: it rebuilt the line
  object field-by-field and was silently dropping `trendDirection` from the incoming batch entry; now
  copies it through.

Added trend-icon and bold-header test cases to `apps/functions/notify-slack/handler.test.ts` (up/down
icon prefix, no-icon for flat/missing, icon on a failed line too); updated the two header-count regex
assertions (`/^Conclusion$/` → `/^\*Conclusion\*$/`, same for Recommended Actions) to match the now-bold
headers. `dispatch/handler.test.ts`'s fixture got `trendDirection: 'up'`. No other existing tests needed
changes (confirmed `persist-result`/`handle-failure`/`batch.test.ts` fixtures omit the now-optional
field and still pass).

Verification: `pnpm build && pnpm lint && pnpm typecheck && pnpm test` all green (150/150 tests, 28/28
files); `pnpm format:check` caught one pre-existing unformatted file from an earlier session
(`packages/aws-repositories/src/coordinate.ts`) — fixed via `prettier --write`, re-verified lint/
typecheck/test green after. `pnpm cdk:synth` (all 6 stacks, staging context) synthesizes cleanly,
confirming the 4 new ASL `TaskInput` fields don't break the state machine graph.

**Not yet deployed** — folds into the same pending `Ingestion`+`Harness` deploy already queued above.

## Raised investigation limits to cut down BUDGET_EXHAUSTED placeholders (2026-10-01)

User reported live Slack output showing the fallback placeholder ("The investigation stopped at a
configured budget limit.") for multiple lines instead of a real Conclusion — `partialAnalysis()` in
`packages/agent-sdk-runtime/src/runner.ts` returns this whenever the Agent SDK session terminates with
`error_max_turns` or `error_max_budget_usd` before producing a structured result. Root cause: the
`investigation`/`tokens` caps in `config/harness.yaml` were too tight for these investigations to
converge. Raised together (hitting any one of them produces the same placeholder, so all were given
headroom):

| field | old | new |
|---|---|---|
| `investigation.maxDurationSeconds` | 600 | 900 |
| `investigation.maxTurns` | 12 | 20 |
| `investigation.maxBudgetUsd` | 0.75 | 1.5 |
| `investigation.maxToolCalls` | 20 | 32 |
| `tokens.maxCumulativeInputTokens` | 80000 | 150000 |
| `tokens.maxCumulativeOutputTokens` | 10000 | 16000 |
| `fargate.taskTimeoutSeconds` | 660 | 960 |

`fargate.taskTimeoutSeconds` (the Step Functions/ECS hard kill on `RunAgentWorkerOnECS`) had to move too
— it was *below* the new `maxDurationSeconds` (900), which would've caused the ECS task to be killed
outright before the graceful BUDGET_EXHAUSTED path could even run, replacing a usable placeholder with a
full `HandleWorkflowError` failure. Kept at a ~60s margin above the new duration cap.

No code changes — config-only (`config/harness.yaml` is read at `cdk synth` time and baked into each
Lambda/ECS task's `HARNESS_CONFIG_JSON` env var, confirmed via `apps/infra/bin/infra.ts`). No schema
validation enforces cross-field ordering (`packages/config/src/harness-config.ts` only checks
type/positivity), so this is a config author's responsibility to keep consistent.

Verification: `pnpm test` still 150/150 green (pure config, no code path exercised by unit tests);
`pnpm cdk:synth --context environment=staging ... CostAgent-staging-Harness` re-run and the synthesized
ASL/`HARNESS_CONFIG_JSON` confirmed to carry the new values (`"TimeoutSeconds":960` on
`RunAgentWorkerOnECS`, `maxTurns:20,maxBudgetUsd:1.5,maxDurationSeconds:900,maxToolCalls:32,...` in the
config JSON).

**Not yet deployed** — same pending `Harness` deploy as everything else above; this makes the deploy
slightly more consequential since it changes real per-investigation USD spend (cap per line went from
$0.75 to $1.50 — review before deploying if there's a budget concern across the 5 concurrent
investigation slots).

## Exclude "Blinx - Management Account" from investigation (2026-10-01)

User request: skip investigating the management account line entirely. Added it to
`significance.excludedLabels` in `config/harness.yaml` (same mechanism already used for "Bedrock Nova
Lite" since 2026-09-30) — `isNotable()` (`packages/core/src/cost-playbook.ts:40`) exact-matches
`line.label` against this list and short-circuits to not-notable, so the line never gets flagged/
enqueued for investigation regardless of its trend. Label confirmed exact-match against
`config/account-map.yaml:8` (`'025031850414': 'Blinx - Management Account'`).

No code changes. Verified via `pnpm cdk:synth ... CostAgent-staging-Ingestion`: the stack's
`EXCLUDED_LABELS_JSON` env var now reads `["Bedrock Nova Lite","Blinx - Management Account"]`
(this list is wired into the `Ingestion` stack, not `Harness` — see `apps/infra/lib/stacks.ts:160`).
`pnpm test` still 150/150 green.

**Not yet deployed** — folds into the same pending `Ingestion` deploy (this is the stack that actually
carries `EXCLUDED_LABELS_JSON`).

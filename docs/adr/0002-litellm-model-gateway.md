# ADR 0002: Route the model provider through a standalone LiteLLM gateway service

- Status: Accepted
- Date: 2026-09-26

## Context

The investigation worker runs the Claude Agent SDK (`query()`, spawning the Claude Code CLI
subprocess). The SDK reads `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from its subprocess environment
and sends Anthropic Messages-API-shaped requests to whatever that URL points at — the same seam the
`bedrock` provider already uses via `CLAUDE_CODE_USE_BEDROCK`.

`paco-troubleshoot-agent`, running in this same AWS account, already hit a real, confirmed problem:
direct Anthropic access on Bedrock is broken here (`INVALID_PAYMENT_INSTRUMENT` on the Anthropic
Marketplace vendor subscription — an account billing issue, not fixable in code, and actively
degrading rather than a one-time outage). It worked around this by running LiteLLM proxy — which
exposes an Anthropic-compatible `/v1/messages` endpoint and translates requests to any configured
backend, including `bedrock/<model-id>` — as a standalone gateway, and landed on Kimi K3 (Moonshot AI,
natively Bedrock-hosted) as the most reliable non-Anthropic route after live-testing several
alternatives (see `config/litellm.yaml`'s comments and that repo's `config/harness.yaml`). Since this
agent runs in the identical account, it is exposed to the identical block, so it adopts the identical
workaround rather than rediscovering it independently.

Two ways to host LiteLLM inside the existing `AgentCluster`:

- **Sidecar** in the same ephemeral per-investigation task definition — simplest wiring, but every
  investigation gets its own cold-started LiteLLM process with no shared rate-limit/budget state across
  concurrent investigations, and the ephemeral worker task role would need direct `bedrock:InvokeModel`
  — the opposite of the isolation `docs/adr/0001` already argues for.
- **Standalone persistent `ecs.FargateService`** — one small long-lived service the ephemeral
  investigation tasks call over the cluster's private DNS (Cloud Map).

## Decision

Run LiteLLM as a standalone, persistent `ecs.FargateService` (`apps/infra/lib/litellm-service.ts`,
ported from `paco-troubleshoot-agent`'s identical construct), provisioned only when
`config/harness.yaml`'s `model.provider` is `litellm`:

- `config/litellm.yaml` maps a stable `model_name` (`kimi-k3`) to the real Bedrock model; the worker
  only ever knows the `model_name` (`config/harness.yaml`'s `model.gatewayModelName`), never the
  underlying provider/model — swapping the active route is a change to `config/litellm.yaml` and
  `config/harness.yaml`'s `upstreamBedrockModelId` only.
- The LiteLLM service's own task role is the only one granted `bedrock:InvokeModel`/
  `InvokeModelWithResponseStream`, scoped to the exact configured model ID
  (`bedrockModelInvokeStatement`, shared with the `bedrock` direct-provider role but never granted to
  both roles for the same worker). The investigation worker task role gets no Bedrock IAM access at
  all in `litellm` mode.
- The worker authenticates to the gateway with a LiteLLM virtual/master key, read from a new, separate
  `CostAgent-<env>-litellm` secret (distinct from `CostAgent-<env>-model`, used by the direct
  `anthropic` provider) — consistent with the exact-ARN secret-read pattern in `docs/adr/0001`.
- A dedicated security group on the LiteLLM service allows inbound port 4000 only from the
  investigation worker task's security group; the worker task is given that security group explicitly
  (rather than the cluster default) only in `litellm` mode.
- Cloud Map private DNS (`cost-agent-<env>.local`) gives the worker a stable
  `http://litellm.cost-agent-<env>.local:4000` base URL without hardcoding IPs.

## Consequences

- One more always-on service and failure boundary in the cluster; an outage or misconfiguration of the
  LiteLLM service blocks all investigations in `litellm` mode.
- The Claude Code harness (system prompt shape, tool-use block format, `stop_reason` semantics) is
  tuned for Claude. LiteLLM's translation layer maps these to whatever the target model's Bedrock API
  actually supports; fidelity loss (no Anthropic-style prompt caching, possibly looser tool-call
  adherence) should be expected and smoke-tested, not assumed away by the plumbing alone —
  `paco-troubleshoot-agent`'s own `tasks/lessons.md` documents a real harness bug this surfaced (the
  SDK's `outputFormat: json_schema` fallback silently starving a non-natively-structured-output model
  of every tool but its own synthetic end-turn one), which is why this agent's `submit_final_analysis`
  is a real MCP tool, not that fallback — see `packages/agent-sdk-runtime/src/tool-server.ts`.
- `upstreamBedrockModelId` must be re-verified against `aws bedrock list-inference-profiles` before
  every deploy — this account's Bedrock model availability has changed within days more than once
  (`config/litellm.yaml`'s comment has the full history).
- Flipping back to a direct `anthropic`/`bedrock` provider once Anthropic access on this account is
  fixed needs no infrastructure code change — only `config/harness.yaml`'s `model.provider` and
  clearing `gatewayModelName`/`upstreamBedrockModelId`.

## Verification

- `packages/config/src/harness-config.test.ts` proves `config/harness.yaml` parses with
  `provider: 'litellm'` and the `gatewayModelName`/`upstreamBedrockModelId` fields populated, and that
  `loadHarnessConfig` throws if `litellm` is selected without both fields set.
- `cdk synth` (verified once with placeholder network/account values, then reverted) confirms the
  LiteLLM `AWS::ECS::Service`/`AWS::ECS::TaskDefinition` and the worker's scoped security group
  construct correctly when `provider: 'litellm'`.
- Not yet done: a live smoke test after deploy (trigger one investigation, confirm in CloudWatch Logs
  that the agent container's `ANTHROPIC_BASE_URL` request reaches the LiteLLM service and a structured
  `FinalCostAnalysis` comes back) — needs a real deployment, see `COST_AGENT_BUILD_SPEC.md` §8.

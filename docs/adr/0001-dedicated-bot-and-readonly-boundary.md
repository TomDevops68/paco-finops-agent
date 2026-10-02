# ADR 0001: dedicated Slack bot, strictly read-only IAM boundary

## Status

Accepted.

## Context

`paco-troubleshoot-agent` already runs a Slack app_mention → parse → investigate → reply-in-thread
agent for incident alerts. This project (`paco-cost-agent`) applies the same pattern to
`paco-daily-cost-report`'s daily "Cloud Spending Analysis" message, but two things differ from a
straight copy:

1. `paco-daily-cost-report` posts via a raw Slack **incoming webhook**, not a bot/app — so there is
   no existing bot identity or Events API subscription tied to that message.
2. The estate already has a separate repo, `paco-saving-lambda`, that performs real cost-saving
   _mutations_: EC2/RDS/Redshift/ECS/ASG start-stop, tag-based saved-count restore, and Fargate
   Spot migration for ECS services.

## Decision

**Dedicated bot.** This agent registers its own Slack app/bot (e.g. `@paco-cost-agent`) rather than
adding a second Events API subscription to the troubleshoot agent's existing app. Slack allows only
one Events API request URL per app, so sharing would mean one endpoint routing between two unrelated
investigation pipelines by message shape. A separate identity keeps "who do I tag for an incident vs.
a cost question" unambiguous, and keeps the two systems independently deployable and independently
disable-able. `app_mention` fires for any message in a channel the bot is invited to regardless of
who/what posted it, so this works fine under a webhook-posted message.

**Strictly read-only.** This agent never calls `paco-saving-lambda`, never mutates AWS resources, and
its IAM role grants only `ce:Get*`, `ce:Describe*`, `savingsplans:Describe*`, `compute-optimizer:Get*`
in the management account, plus cross-account `*:Describe*`/`*:List*` (never write) roles into linked
accounts for resource-level correlation. Where a recommendation applies, it names the existing lever
(`fargate-spot-migrator`, `scheduler-worker`, `RdsAuroraSchedulerStack`) for a human to invoke, rather
than reinventing remediation logic or calling it directly. This mirrors `paco-troubleshoot-agent`'s
own non-goal ("never change production resources") and keeps the blast radius of a coding-agent-built
Lambda/ECS worker limited to read access no matter what it concludes.

## Consequences

- A workspace admin needs to install a second Slack app and invite it to the cost-report channel.
- Recommendations reference `paco-saving-lambda`/`RdsAuroraSchedulerStack` by name but can't verify
  their current state beyond what read-only `Describe*` calls expose (e.g. it can see an ECS service's
  current desired count and capacity provider strategy, but not `paco-saving-lambda`'s own
  `paco:saved-count` tag semantics without also reading that tag — a `describe_resources` evidence tool
  scope decision for Phase 2, not this ADR).
- If `paco-daily-cost-report`'s `ACCOUNT_MAP` changes (an account renamed, or one of the currently
  commented-out accounts enabled), `config/account-map.yaml` here must be updated by hand — there is no
  shared source of truth between the two repos.

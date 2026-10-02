# Slack app setup — dedicated bot, two phases

Per `docs/adr/0001-dedicated-bot-and-readonly-boundary.md`: a **new, separate** Slack app, not an
addition to `paco-troubleshoot-agent`'s existing bot (Slack allows only one Events API Request URL per
app).

## Phase A — do this now, no deploy needed

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest** → pick the Blinx
   workspace → paste the contents of `manifest.yaml` in this folder.
2. **Install to Workspace** (OAuth & Permissions page → top of the page). This is what actually grants
   the bot the scopes and gives you a token.
3. Copy two values:
   - **Bot User OAuth Token** (OAuth & Permissions page — starts `xoxb-`) → `.env`'s
     `SLACK_BOT_TOKEN`.
   - **Signing Secret** (Basic Information page → App Credentials — _not_ a bot scope, an app-level
     credential used to verify inbound requests are really from Slack) → `.env`'s
     `SLACK_SIGNING_SECRET`.
4. Run `pnpm seed-secrets --environment staging` to push both into Secrets Manager
   (`CostAgent-staging-slack`, `CostAgent-staging-slack-signing`).

Event Subscriptions is deliberately **not** enabled yet — see Phase B.

## Phase B — after the first `cdk deploy`

The Slack Events API requires a live, publicly reachable URL that answers its verification challenge
before you can save an Event Subscription — `IngestionStack`'s `SlackEventsUrl` CDK output doesn't
exist until the first deploy.

1. Deploy (`pnpm cdk:deploy --context environment=staging ...`), note the `SlackEventsUrl` output
   (`https://<api-id>.execute-api.eu-west-2.amazonaws.com/staging/slack-events`).
2. In the Slack app config: **Event Subscriptions** → toggle on → paste that URL as the **Request
   URL**. Slack will call it immediately; `apps/functions/slack-events/handler.ts` already answers the
   `url_verification` challenge, so this should go green without any code change.
3. Under **Subscribe to bot events**, add `app_mention`. Save.
4. Reinstall the app if Slack prompts you to (adding an event subscription sometimes requires it).
5. **Invite the bot to the channel** where `paco-daily-cost-report` posts the daily "Cloud Spending
   Analysis" message (`/invite @PACO Cost Agent` in that channel, or add it via channel settings). The
   bot only sees `app_mention` events, and can only read message history, in channels it's a member of
   — this step is required regardless of whether the channel is public or private.
6. Set `config/harness.yaml`'s `staging.slack.enabled: true` and `slack.channelId` to that channel's
   ID (visible in the channel's "About" panel, or via `conversations.list`).

## What this bot can't do (by design)

No file access, no reactions, no slash commands, no interactivity/buttons, no user lookups — the scope
list above is the complete set `packages/slack-connector/src/client.ts` and
`apps/functions/{slack-events,notify-slack}` actually call. Nothing broader was requested.

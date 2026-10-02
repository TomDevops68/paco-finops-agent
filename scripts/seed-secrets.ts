import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Ported from paco-troubleshoot-agent's `scripts/seed-secrets.ts` — the
 * "injected out of band" step every secret's CDK description promises never
 * actually happens by hand in the Secrets Manager console. It reads a local
 * `.env` (gitignored, never committed) and pushes real values into the
 * already-CDK-created empty secrets via `PutSecretValueCommand`. The
 * deployed worker/Lambdas only ever read secrets from Secrets Manager, never
 * from environment variables directly — this script's only job is getting a
 * real value into the container CDK already created.
 */
function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (value) values[key] = value;
  }
  return values;
}

function parseEnvironmentArg(argv: string[]): string {
  const flagIndex = argv.indexOf('--environment');
  const value = flagIndex !== -1 ? argv[flagIndex + 1] : undefined;
  if (value && !['dev', 'staging', 'prod'].includes(value)) {
    throw new Error(`Unknown --environment: ${value}`);
  }
  return value ?? 'dev';
}

interface SecretPlan {
  name: string;
  secretString: string;
}

function buildSecretPlans(env: Record<string, string>, environment: string): SecretPlan[] {
  const plans: SecretPlan[] = [];

  if (env.SLACK_BOT_TOKEN) {
    // Read as a raw string by notify-slack/slack-events, not JSON.
    plans.push({ name: `CostAgent-${environment}-slack`, secretString: env.SLACK_BOT_TOKEN });
  }

  if (env.SLACK_SIGNING_SECRET) {
    // Distinct secret from -slack (the bot token): verifies inbound Slack
    // Events API requests (apps/functions/slack-events), never sent as a
    // bearer token anywhere. Raw string, like the bot token.
    plans.push({
      name: `CostAgent-${environment}-slack-signing`,
      secretString: env.SLACK_SIGNING_SECRET,
    });
  }

  if (env.ANTHROPIC_API_KEY) {
    // Only read when config/harness.yaml's model.provider is "anthropic" —
    // unused while it's "litellm" (docs/adr/0002), kept for flexibility if
    // that ever flips back.
    plans.push({
      name: `CostAgent-${environment}-model`,
      secretString: JSON.stringify({ apiKey: env.ANTHROPIC_API_KEY }),
    });
  }

  if (env.LITELLM_MASTER_KEY) {
    // Distinct secret name from -model (docs/adr/0002): the worker
    // authenticates to the LiteLLM gateway, not to api.anthropic.com, with
    // a separate key. Read as JSON {apiKey} by both the LiteLLM container's
    // own field-selector secret injection (apps/infra/lib/litellm-service.ts)
    // and the worker (apps/agent-worker/src/main.ts).
    plans.push({
      name: `CostAgent-${environment}-litellm`,
      secretString: JSON.stringify({ apiKey: env.LITELLM_MASTER_KEY }),
    });
  }

  return plans;
}

async function main(): Promise<void> {
  const environment = parseEnvironmentArg(process.argv.slice(2));
  const envPath = resolve(process.cwd(), '.env');
  const contents = await readFile(envPath, 'utf8').catch(() => {
    throw new Error(
      `No .env file found at ${envPath}. Copy .env.example to .env and fill it in first.`,
    );
  });
  const env = parseEnvFile(contents);
  const plans = buildSecretPlans(env, environment);

  if (plans.length === 0) {
    console.log(
      'Nothing to seed: .env has none of SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY, LITELLM_MASTER_KEY set.',
    );
    return;
  }

  const client = new SecretsManagerClient({});
  for (const plan of plans) {
    await client.send(
      new PutSecretValueCommand({ SecretId: plan.name, SecretString: plan.secretString }),
    );
    console.log(`Updated ${plan.name}`);
  }
}

await main();

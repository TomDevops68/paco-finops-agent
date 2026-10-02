import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { loadHarnessConfig } from './harness-config.js';

const REPO_CONFIG_PATH = fileURLToPath(new URL('../../../config/harness.yaml', import.meta.url));

describe('loadHarnessConfig', () => {
  it('loads and validates the real config/harness.yaml for dev', async () => {
    const config = await loadHarnessConfig(REPO_CONFIG_PATH, 'dev');
    expect(config.environments.dev.connectorMode).toBe('mock');
    expect(config.agentSdk.enabledMcpTools).toContain('mcp__cost__get_cost_and_usage');
    expect(config.investigation.maxBudgetUsd).toBeGreaterThan(0);
  });

  it('fails closed for prod as shipped (target account/region/network are not yet filled in)', async () => {
    await expect(loadHarnessConfig(REPO_CONFIG_PATH, 'prod')).rejects.toThrow(
      'prod configuration is fail-closed until target and allowlists are explicit',
    );
  });

  it('rejects an unknown target environment', async () => {
    await expect(loadHarnessConfig(REPO_CONFIG_PATH, 'qa')).rejects.toThrow(
      'Unknown target environment: qa',
    );
  });
});

describe('loadHarnessConfig (slack validation)', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('rejects an environment with slack enabled but no channelId', async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-config-'));
    const path = join(dir, 'harness.yaml');
    const base = await loadHarnessConfig(REPO_CONFIG_PATH, 'dev');
    const broken = {
      ...base,
      environments: {
        ...base.environments,
        dev: { ...base.environments.dev, slack: { enabled: true, channelId: null } },
      },
    };
    await writeFile(path, JSON.stringify(broken), 'utf8');
    await expect(loadHarnessConfig(path, 'dev')).rejects.toThrow(
      'dev.slack.enabled requires dev.slack.channelId',
    );
  });
});

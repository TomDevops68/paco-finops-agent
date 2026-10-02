import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlaybooksConfig, selectRoutingPlaybook } from './playbooks-config.js';

const REPO_CONFIG_PATH = fileURLToPath(new URL('../../../config/playbooks.yaml', import.meta.url));

describe('loadPlaybooksConfig', () => {
  it('loads and validates the real config/playbooks.yaml', async () => {
    const config = await loadPlaybooksConfig(REPO_CONFIG_PATH);
    expect(config.selection.new).toBe('NEW_SERVICE_OR_USAGE_TYPE');
    expect(config.selection.fallback).toBe('GENERIC');
    expect(config.playbooks.GENERIC?.enabledTools).toContain('mcp__cost__describe_resources');
  });

  it('selectRoutingPlaybook routes new lines narrower than everything else', async () => {
    const config = await loadPlaybooksConfig(REPO_CONFIG_PATH);
    expect(selectRoutingPlaybook(config, 'new')).toBe('NEW_SERVICE_OR_USAGE_TYPE');
    expect(selectRoutingPlaybook(config, 'increase')).toBe('GENERIC');
    expect(selectRoutingPlaybook(config, 'decrease')).toBe('GENERIC');
    expect(selectRoutingPlaybook(config, 'unchanged')).toBe('GENERIC');
  });
});

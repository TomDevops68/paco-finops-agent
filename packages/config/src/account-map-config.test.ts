import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAccountMapConfig } from './account-map-config.js';

const REPO_CONFIG_PATH = fileURLToPath(
  new URL('../../../config/account-map.yaml', import.meta.url),
);

describe('loadAccountMapConfig', () => {
  it('loads and validates the real config/account-map.yaml', async () => {
    const config = await loadAccountMapConfig(REPO_CONFIG_PATH);
    expect(config.accounts['510825518696']).toBe('PACO - Production');
    expect(config.accounts['680099409919']).toBe('PACO - Non-Production');
    expect(config.accounts['025031850414']).toBe('Blinx - Management Account');
  });
});

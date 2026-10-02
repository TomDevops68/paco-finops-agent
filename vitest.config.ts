import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});

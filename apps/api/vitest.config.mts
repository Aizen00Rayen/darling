import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Every test file clones its own database from the template; creating it can be slow.
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});

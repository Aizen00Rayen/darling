import { defineConfig, devices } from '@playwright/test';
import { childEnv, WEB_ORIGIN, WEB_PORT, webEnv } from './e2e/env';

const CI = Boolean(process.env.CI);

/**
 * End-to-end suite. Requires the local infrastructure (`pnpm infra:up`: Postgres + Mailpit).
 * Own database (`darling_e2e`), own ports (API 4100, web 3100) and origin, so it runs next to the dev
 * servers. Serial: the tests share one database and one owner account.
 *
 * The web app is a production build served by `next start` (the realistic setup; the build takes
 * about a minute). The API is started by `globalSetup` (see there), once its database exists, and
 * stopped, with the database dropped, by the teardown it returns.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: WEB_ORIGIN,
    locale: 'fr-FR',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm --filter @darling/web exec next build && pnpm --filter @darling/web exec next start -p ${WEB_PORT}`,
      port: WEB_PORT,
      env: childEnv(webEnv()),
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});

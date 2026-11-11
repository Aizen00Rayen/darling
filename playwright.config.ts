import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (npm run test:e2e). One worker, serial: the scenarios build on each other (see e2e/launch.spec.ts).
//
// The app runs from a PRODUCTION BUILD (`next build` ~1.5 min, then `next start`) on port 3100 with a throwaway
// DATA_DIR, throwaway secrets and a mail outbox directory, all created here once per run (the config file is loaded
// by the runner and by every worker; the first load stores the values in process.env, later loads reuse them).
// `next start` forces NODE_ENV=production unless told otherwise, and the production guard rails (https origin, Secure
// cookies, no mail outbox) would refuse http://localhost, so the server is started with NODE_ENV=test; the build
// itself runs with the default. Set E2E_SKIP_BUILD=1 to reuse an existing `.next` build while iterating.

const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;

process.env.E2E_RUN_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'darling-e2e-'));
process.env.E2E_SETUP_TOKEN ??= crypto.randomBytes(32).toString('hex');
process.env.E2E_ENCRYPTION_KEY ??= crypto.randomBytes(32).toString('base64');
const runDir = process.env.E2E_RUN_DIR;

const server = `NODE_ENV=test npx next start -p ${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'fr-FR',
    timezoneId: 'Africa/Algiers',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? server : `npm run build && ${server}`,
    url: `${ORIGIN}/api/health`,
    timeout: 360_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      APP_ORIGIN: ORIGIN,
      COOKIE_SECURE: 'false',
      DATA_DIR: path.join(runDir, 'data'),
      MAIL_OUTBOX_DIR: path.join(runDir, 'mail'),
      ENCRYPTION_KEY: process.env.E2E_ENCRYPTION_KEY,
      SETUP_TOKEN: process.env.E2E_SETUP_TOKEN,
      TRUSTED_PROXY_HOPS: '1',
      // A developer's .env must not leak into the run.
      SMTP_URL: '',
      MAIL_FROM: '',
      CRON_TOKEN: '',
      BACKUP_KEEP: '',
      ALLOW_DATA_IN_APP_DIR: '',
      PORT: String(PORT),
    },
  },
});

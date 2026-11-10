import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Repo-root .env (git-ignored). Variables already in the environment (CI) win.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

export const TEMPLATE_DB = 'darling_test_template';

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} must be set to run the API tests (see .env.example)`);
  return value;
}

/** The same server and credentials as `url`, pointed at another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Owner credentials, pointed at the maintenance `postgres` database. */
export function ownerAdminUrl(): string {
  return withDatabase(requireEnv('TEST_DATABASE_OWNER_URL'), 'postgres');
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';

/**
 * Shared constants for the end-to-end suite. The suite runs against its own database, ports and
 * origin so it can run while the dev servers (3000/4000) and the dev database are up.
 */
export const WEB_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '../..');
export const TMP_DIR = path.join(WEB_ROOT, 'e2e', '.tmp');

// The repo-root .env (local dev) supplies secrets and the Postgres URLs. CI has no .env: the same
// variables come from the job's `env`. Existing variables always win.
loadEnvConfig(REPO_ROOT, true, { info: () => {}, error: console.error }, false);

export const E2E_DB = 'darling_e2e';
export const API_PORT = 4100;
export const WEB_PORT = 3100;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const API_ORIGIN = `http://localhost:${API_PORT}`;
export const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, '');

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (repo-root .env locally, job env in CI)`);
  return value;
}

/** The same server, credentials and options, another database. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Owner role (migrations, DDL), derived from the admin URL every environment already provides. */
export const ownerAdminUrl = (): string => requireEnv('TEST_DATABASE_OWNER_URL');
export const e2eOwnerUrl = (): string => withDatabase(ownerAdminUrl(), E2E_DB);
/** Runtime role: DATABASE_URL (the app role) pointed at the e2e database. */
export const e2eAppUrl = (): string => withDatabase(requireEnv('DATABASE_URL'), E2E_DB);

/**
 * PATH for the child processes (pnpm, tsx, next). The repo needs Node 22; when this process is
 * already on Node >= 22 nothing changes, otherwise the fnm-installed Node 22 is put first if present.
 */
export function pathWithNode22(): string {
  const current = process.env.PATH ?? '';
  if (Number(process.versions.node.split('.')[0]) >= 22) return current;
  const bin = path.join(os.homedir(), '.local/share/fnm/node-versions/v22.23.4/installation/bin');
  return fs.existsSync(bin) ? `${bin}${path.delimiter}${current}` : current;
}

/** Environment for a child process: ours, with Node 22 first and the e2e overrides on top. */
export function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv & Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  return { ...base, PATH: pathWithNode22(), ...overrides } as unknown as NodeJS.ProcessEnv & Record<string, string>;
}

/** The API process: e2e database, port and origin; secrets and SMTP come from the root .env / job env. */
export function apiEnv(): Record<string, string> {
  return {
    API_PORT: String(API_PORT),
    APP_ORIGIN: WEB_ORIGIN,
    DATABASE_URL: e2eAppUrl(),
    DATABASE_OWNER_URL: e2eOwnerUrl(),
    COOKIE_SECURE: 'false',
  };
}

/** The web process: only what the web app reads. */
export function webEnv(): Record<string, string> {
  return { API_INTERNAL_URL: API_ORIGIN, APP_ORIGIN: WEB_ORIGIN, COOKIE_SECURE: 'false', NODE_ENV: 'production' };
}

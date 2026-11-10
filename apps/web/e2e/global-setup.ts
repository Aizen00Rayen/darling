import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { API_ORIGIN, apiEnv, childEnv, E2E_DB, e2eOwnerUrl, MAILPIT_URL, ownerAdminUrl, REPO_ROOT, TMP_DIR, WEB_ORIGIN } from './env';

export const OWNER_EMAIL = 'owner@e2e.darling.test';
export const OWNER_NAME = 'Owner E2E';
export const BOOTSTRAP_FILE = path.join(TMP_DIR, 'bootstrap.json');

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function pnpm(args: string[], env: Record<string, string>): string {
  const result = spawnSync('pnpm', args, { cwd: REPO_ROOT, env: childEnv(env), encoding: 'utf8' });
  if (result.status !== 0) {
    // stderr may carry a stack but never the invitation link (stdout) or secrets.
    throw new Error(`pnpm ${args.join(' ')} failed (${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

async function createDatabase(): Promise<void> {
  await withClient(ownerAdminUrl(), (admin) => admin.query(`create database ${E2E_DB} owner darling_owner`));
  // Same per-database privileges infra/postgres/init.sql sets, before the migrations create tables.
  await withClient(e2eOwnerUrl(), async (db) => {
    await db.query('alter schema public owner to darling_owner');
    await db.query('grant usage on schema public to darling_app');
    await db.query(
      'alter default privileges for role darling_owner in schema public grant select, insert, update, delete on tables to darling_app',
    );
    await db.query(
      'alter default privileges for role darling_owner in schema public grant usage, select on sequences to darling_app',
    );
  });
}

async function dropDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ownerAdminUrl() });
  await admin.connect();
  try {
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [E2E_DB]);
    await admin.query(`drop database if exists ${E2E_DB}`);
  } finally {
    await admin.end();
  }
}

/** Starts the API on the e2e port in its own process group; resolves once /api/health answers 200. */
async function startApi(): Promise<{ stop: () => Promise<void> }> {
  const child = spawn('pnpm', ['--filter', '@darling/api', 'start'], {
    cwd: REPO_ROOT,
    env: childEnv(apiEnv()),
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };
  const stop = async () => {
    // SIGTERM lets the API close its database pool; only then can the database be dropped.
    killGroup('SIGTERM');
    for (let i = 0; i < 50 && !exited; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!exited) killGroup('SIGKILL');
  };

  for (let i = 0; i < 300; i += 1) {
    if (exited) break;
    const ok = await fetch(`${API_ORIGIN}/api/health`).then((r) => r.ok, () => false);
    if (ok) return { stop };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw new Error(`The API did not become healthy on ${API_ORIGIN}:\n${stderr}`);
}

/**
 * Recreates `darling_e2e` from scratch (so every run starts clean), migrates it, empties Mailpit,
 * creates the first owner with the real CLI and starts the API on it. The invitation link goes to
 * a git-ignored file. Returns the teardown: stop the API, drop the database, remove the state files.
 *
 * The API is started here rather than by Playwright's `webServer` because dropping the database
 * needs the API's connections closed first, and the owner role may not terminate other roles'
 * sessions; Playwright would only stop a webServer after the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  let stopApi: (() => Promise<void>) | undefined;
  const teardown = async () => {
    await stopApi?.();
    await dropDatabase();
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  };

  try {
    await dropDatabase();
    await createDatabase();
    pnpm(['--filter', '@darling/api', 'db:migrate'], apiEnv());

    const cleared = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' }).catch(() => null);
    if (!cleared?.ok) throw new Error(`Mailpit is not reachable at ${MAILPIT_URL} (pnpm infra:up)`);

    const out = pnpm(['--filter', '@darling/api', 'create-owner', '--email', OWNER_EMAIL, '--name', OWNER_NAME], apiEnv());
    const link = out.match(new RegExp(`${WEB_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invitation\\?token=[A-Za-z0-9_-]+`))?.[0];
    if (!link) throw new Error('create-owner did not print an invitation link');

    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(BOOTSTRAP_FILE, JSON.stringify({ email: OWNER_EMAIL, name: OWNER_NAME, invitationUrl: link }), { mode: 0o600 });

    stopApi = (await startApi()).stop;
  } catch (error) {
    await teardown().catch(() => {});
    throw error;
  }
  return teardown;
}

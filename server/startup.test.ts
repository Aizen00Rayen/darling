import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from './db';
import { runInBackground, settleBackgroundWork } from './mail/outbox';
import { drainBackgroundWork, installShutdownDrain, runStartupChecks } from './startup';
import { ConfigError } from './config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-startup-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('runStartupChecks', () => {
  it('opens the database and applies migrations for a valid configuration', () => {
    const dir = tmp();
    vi.stubEnv('DATA_DIR', dir);
    const result = runStartupChecks({ NODE_ENV: 'test', DATA_DIR: dir });
    expect(result.config.dataDir).toBe(dir);
    expect(fs.existsSync(path.join(dir, 'darling.sqlite'))).toBe(true);
  });

  it('throws a ConfigError for a bad production configuration (the server must not start)', () => {
    expect(() => runStartupChecks({ NODE_ENV: 'production', APP_ORIGIN: 'http://x.test', DATA_DIR: tmp(), ENCRYPTION_KEY: KEY })).toThrow(ConfigError);
  });

  it('throws for an unparseable SMTP_URL that config alone would accept', () => {
    const dir = tmp();
    vi.stubEnv('DATA_DIR', dir);
    expect(() => runStartupChecks({ NODE_ENV: 'test', DATA_DIR: dir, SMTP_URL: 'smtp://localhost:1025?starttls=maybe' })).toThrow(/starttls/);
  });

  it('throws when the data directory cannot be used', () => {
    const file = path.join(tmp(), 'a-file');
    fs.writeFileSync(file, 'x');
    vi.stubEnv('DATA_DIR', path.join(file, 'sub'));
    expect(() => runStartupChecks({ NODE_ENV: 'test', DATA_DIR: path.join(file, 'sub') })).toThrow();
  });
});

describe('drainBackgroundWork / installShutdownDrain', () => {
  it('returns as soon as the pending work has settled', async () => {
    const started = Date.now();
    await drainBackgroundWork(5_000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('gives up after the cap when work never finishes', async () => {
    let release!: () => void;
    runInBackground('hang', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setImmediate(r)); // let the task start
    const started = Date.now();
    await drainBackgroundWork(50);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(45);
    expect(took).toBeLessThan(1_000);
    release();
    await settleBackgroundWork();
  });

  it('registers once-handlers for SIGTERM and SIGINT that drain with a 5 s cap', async () => {
    const handlers = new Map<string, () => void>();
    const proc = { once: (sig: string, fn: () => void) => void handlers.set(sig, fn) };
    const drain = vi.fn(async () => {});
    installShutdownDrain(proc, drain);
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')!();
    expect(drain).toHaveBeenCalledWith(5_000);
  });

  it('drains the real queue: a mail still being sent is waited for', async () => {
    let done = false;
    runInBackground('slow', async () => {
      await new Promise((r) => setTimeout(r, 30));
      done = true;
    });
    await drainBackgroundWork(2_000);
    expect(done).toBe(true);
    await settleBackgroundWork();
  });
});

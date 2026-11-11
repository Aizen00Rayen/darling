import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, login, seedUser, totpCodeAt, type TestApp } from '../test/app';
import { BACKUP_NAME_RE, listBackups } from './backup';

const TOKEN = 'k'.repeat(40);
let app: TestApp;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-routes-'));
  app = createTestApp({ file: true, config: { dataDir: dir, cronToken: TOKEN, backupKeep: 3 } });
});
afterEach(() => {
  app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function sessionOf(init: Parameters<typeof seedUser>[1]): Promise<{ cookie: string; id: string; email: string }> {
  const u = await seedUser(app, { totp: init.role === 'super_manager', ...init });
  const cookie = await login(app, u.email, u.password, { totpCode: u.totpSecret ? totpCodeAt(u.totpSecret, app.clock.now()) : undefined });
  return { cookie, id: u.id, email: u.email };
}
const owner = () => sessionOf({ role: 'super_manager', isOwner: true });
const manager = () => sessionOf({ role: 'super_manager', permissions: ['orders.read', 'orders.write', 'settings.manage', 'audit.read', 'users.manage'] });

const audit = (action: string) =>
  app.db.all<{ actor_user_id: string | null; entity_id: string; ip: string | null }>('SELECT actor_user_id, entity_id, ip FROM audit_log WHERE action = ?', action);

describe('POST /api/backups', () => {
  it('lets the owner create a backup, audited with the owner as actor', async () => {
    const o = await owner();
    const res = await app.call('/api/backups', { method: 'POST', cookie: o.cookie, ip: '203.0.113.5' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: expect.stringMatching(BACKUP_NAME_RE), bytes: expect.any(Number), at: app.clock.now() });
    expect(JSON.stringify(body)).not.toContain(dir); // no server path in the answer
    expect(listBackups(dir)).toHaveLength(1);
    expect(audit('backup.created')).toEqual([{ actor_user_id: o.id, entity_id: body.name, ip: '203.0.113.5' }]);
  });

  it('refuses a super manager who is not the owner, the unauthenticated and the other roles', async () => {
    const m = await manager();
    expect((await app.call('/api/backups', { method: 'POST', cookie: m.cookie })).status).toBe(403);
    expect((await app.call('/api/backups', { method: 'POST' })).status).toBe(401);
    expect(listBackups(dir)).toHaveLength(0);
  });

  it('requires the CSRF headers', async () => {
    const o = await owner();
    const res = await app.call('/api/backups', { method: 'POST', cookie: o.cookie, headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'csrf' });
  });
});

describe('GET /api/backups/latest', () => {
  it('404 when there is no backup', async () => {
    const o = await owner();
    expect((await app.call('/api/backups/latest', { cookie: o.cookie })).status).toBe(404);
  });

  it('streams the newest backup as a non-cacheable attachment and audits the download', async () => {
    const o = await owner();
    await app.call('/api/backups', { method: 'POST', cookie: o.cookie });
    app.clock.advance(60_000);
    const second = await (await app.call('/api/backups', { method: 'POST', cookie: o.cookie })).json();
    const res = await app.call('/api/backups/latest', { cookie: o.cookie, ip: '203.0.113.6' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${second.name}"`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(second.bytes);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    expect(res.headers.get('content-length')).toBe(String(second.bytes));
    expect(audit('backup.downloaded')).toEqual([{ actor_user_id: o.id, entity_id: second.name, ip: '203.0.113.6' }]);
  });

  it('is owner-only', async () => {
    const o = await owner();
    await app.call('/api/backups', { method: 'POST', cookie: o.cookie });
    const m = await manager();
    expect((await app.call('/api/backups/latest', { cookie: m.cookie })).status).toBe(403);
    expect((await app.call('/api/backups/latest')).status).toBe(401);
    expect(audit('backup.downloaded')).toHaveLength(0);
  });

  it('never serves a file outside the backups directory (planted symlink, foreign names)', async () => {
    const o = await owner();
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP SECRET');
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'backups', 'darling-20300101-000000.sqlite'));
    fs.writeFileSync(path.join(dir, 'backups', 'notes.txt'), 'x');
    const res = await app.call('/api/backups/latest', { cookie: o.cookie });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SECRET');
  });
});

describe('POST /api/cron/backup', () => {
  const cron = (headers: Record<string, string | null> = {}, ip?: string) =>
    app.call('/api/cron/backup', { method: 'POST', ip, headers: { Origin: null, 'X-Requested-With': null, Authorization: `Bearer ${TOKEN}`, ...headers } });

  it('creates a backup for a valid bearer token, audited with no actor', async () => {
    const res = await cron();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, name: expect.stringMatching(BACKUP_NAME_RE) });
    expect(listBackups(dir)).toHaveLength(1);
    expect(audit('backup.created')).toMatchObject([{ actor_user_id: null, entity_id: body.name }]);
  });

  it('answers 404 when CRON_TOKEN is not set', async () => {
    app.close();
    app = createTestApp({ file: true, config: { dataDir: dir, cronToken: undefined } });
    const res = await cron();
    expect(res.status).toBe(404);
    expect(listBackups(dir)).toHaveLength(0);
  });

  it('refuses wrong or missing tokens with 401 and creates nothing', async () => {
    expect((await cron({ Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await cron({ Authorization: null })).status).toBe(401);
    expect(listBackups(dir)).toHaveLength(0);
  });

  it('refuses browser requests (Origin) even with the token', async () => {
    expect((await cron({ Origin: 'http://localhost:3000' })).status).toBe(403);
    expect(listBackups(dir)).toHaveLength(0);
  });

  it('is throttled to 10 calls an hour per address', async () => {
    for (let i = 0; i < 10; i += 1) expect((await cron({}, '203.0.113.77')).status).toBe(200);
    expect((await cron({}, '203.0.113.77')).status).toBe(429);
    // retention keeps the pile at BACKUP_KEEP
    expect(listBackups(dir)).toHaveLength(3);
  });

  it('only accepts POST', async () => {
    const res = await app.call('/api/cron/backup', { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });
});

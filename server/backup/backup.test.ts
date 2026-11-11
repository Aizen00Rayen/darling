import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../db/migrate';
import { openDatabase } from '../db/sqlite';
import { fixedClock } from '../clock';
import { testConfig } from '../test/app';
import { BACKUP_NAME_RE, backupFileName, createBackup, latestBackup, listBackups, verifyBackupFile } from './backup';

const dirs: string[] = [];
function setup(over: { keep?: number; start?: number } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-backup-'));
  dirs.push(dataDir);
  const db = openDatabase(path.join(dataDir, 'darling.sqlite'));
  applyMigrations(db);
  const clock = fixedClock(over.start ?? Date.UTC(2026, 10, 11, 12, 30, 5)); // 13:30:05 in Algiers
  const config = testConfig({ dataDir, backupKeep: over.keep ?? 14 });
  return { dataDir, db, clock, config, ctx: { db, clock, config } };
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('backupFileName', () => {
  it('uses Algiers time (UTC+1)', () => {
    expect(backupFileName(Date.UTC(2026, 10, 11, 12, 30, 5))).toBe('darling-20261111-133005.sqlite');
    expect(backupFileName(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('darling-20270101-005959.sqlite');
    expect(backupFileName(Date.UTC(2026, 10, 11, 12, 30, 5), 2)).toBe('darling-20261111-133005-2.sqlite');
  });
  it('matches its own pattern only', () => {
    expect(BACKUP_NAME_RE.test('darling-20261111-133005.sqlite')).toBe(true);
    expect(BACKUP_NAME_RE.test('darling-20261111-133005-2.sqlite')).toBe(true);
    for (const bad of ['darling.sqlite', '../darling-20261111-133005.sqlite', 'darling-20261111-133005.sqlite-wal', 'x.sqlite']) {
      expect(BACKUP_NAME_RE.test(bad)).toBe(false);
    }
  });
});

describe('createBackup', () => {
  it('copies the live database into <DATA_DIR>/backups, verified, and records the audit row', async () => {
    const { ctx, dataDir, db } = setup();
    db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('company.name', '"Darling"', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const result = await createBackup(ctx, { actorUserId: null });
    expect(result.path).toBe(path.join(dataDir, 'backups', 'darling-20261111-133005.sqlite'));
    expect(result.bytes).toBe(fs.statSync(result.path).size);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.at).toBe(ctx.clock.now());
    expect(verifyBackupFile(result.path)).toEqual({ ok: true });
    // the copy holds the data and is a stand-alone file (no -wal/-shm companions, no partial leftovers)
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual(['darling-20261111-133005.sqlite']);
    const copy = openDatabase(result.path);
    expect(copy.get<{ n: number }>("SELECT count(*) AS n FROM settings WHERE key = 'company.name'")?.n).toBe(1);
    copy.close();
    const audit = db.all<{ actor_user_id: string | null; action: string; entity_type: string; entity_id: string; after: string }>(
      "SELECT actor_user_id, action, entity_type, entity_id, after FROM audit_log WHERE action = 'backup.created'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: null, entity_type: 'backup', entity_id: 'darling-20261111-133005.sqlite' });
    expect(JSON.parse(audit[0]!.after)).toEqual({ bytes: result.bytes });
  });

  it('records the acting user when there is one', async () => {
    const { ctx, db } = setup();
    const id = '018f0000-0000-7000-8000-000000000001';
    db.run(
      `INSERT INTO users (id, email, full_name, role, status, is_owner, created_at, updated_at) VALUES (?, 'o@example.test', 'O', 'super_manager', 'active', 1, 1, 1)`,
      id,
    );
    await createBackup(ctx, { actorUserId: id, ip: '203.0.113.9' });
    expect(db.get<{ actor_user_id: string; ip: string }>("SELECT actor_user_id, ip FROM audit_log WHERE action = 'backup.created'")).toMatchObject({
      actor_user_id: id,
      ip: '203.0.113.9',
    });
  });

  it('keeps only the newest BACKUP_KEEP files', async () => {
    const { ctx, dataDir } = setup({ keep: 3 });
    for (let i = 0; i < 6; i += 1) {
      await createBackup(ctx, { actorUserId: null });
      ctx.clock.advance(60_000);
    }
    const names = fs.readdirSync(path.join(dataDir, 'backups')).sort();
    expect(names).toEqual(['darling-20261111-133305.sqlite', 'darling-20261111-133405.sqlite', 'darling-20261111-133505.sqlite']);
    expect(listBackups(dataDir).map((b) => b.name)).toEqual([...names].reverse());
  });

  it('retention never touches foreign files in the backups directory', async () => {
    const { ctx, dataDir } = setup({ keep: 1 });
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, 'darling.sqlite'), 'not a backup name');
    await createBackup(ctx, { actorUserId: null });
    ctx.clock.advance(1000);
    await createBackup(ctx, { actorUserId: null });
    expect(fs.readdirSync(dir).sort()).toEqual(['darling-20261111-133006.sqlite', 'darling.sqlite', 'notes.txt']);
  });

  it('serialises concurrent backups: all succeed, none overwrites another, the pile stays within the limit', async () => {
    const { ctx, dataDir } = setup({ keep: 14 });
    const results = await Promise.all(Array.from({ length: 6 }, () => createBackup(ctx, { actorUserId: null })));
    expect(new Set(results.map((r) => r.path)).size).toBe(6);
    const names = fs.readdirSync(path.join(dataDir, 'backups')).sort();
    expect(names).toHaveLength(6);
    expect(names.every((n) => BACKUP_NAME_RE.test(n))).toBe(true);
    for (const r of results) expect(verifyBackupFile(r.path)).toEqual({ ok: true });
    // the newest by name is the last one created
    expect(latestBackup(dataDir)?.name).toBe(path.basename(results[5]!.path));
  });

  it('two backups in the same second get distinct names, ordered by creation', async () => {
    const { ctx, dataDir } = setup();
    const a = await createBackup(ctx, { actorUserId: null });
    const b = await createBackup(ctx, { actorUserId: null });
    expect(path.basename(a.path)).toBe('darling-20261111-133005.sqlite');
    expect(path.basename(b.path)).toBe('darling-20261111-133005-2.sqlite');
    expect(latestBackup(dataDir)?.name).toBe('darling-20261111-133005-2.sqlite');
  });

  it('detects a corrupt copy: the file is deleted, nothing is counted, no audit row, and older backups survive', async () => {
    const { ctx, dataDir, db } = setup();
    const good = await createBackup(ctx, { actorUserId: null });
    ctx.clock.advance(5000);
    await expect(
      createBackup(ctx, {
        actorUserId: null,
        hooks: {
          afterCopy(file) {
            const fd = fs.openSync(file, 'r+');
            fs.writeSync(fd, Buffer.alloc(200, 0xff), 0, 200, 100); // scribble over the first pages
            fs.closeSync(fd);
          },
        },
      }),
    ).rejects.toThrow(/verification/i);
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([path.basename(good.path)]);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE action = 'backup.created'")?.n).toBe(1);
  });

  it('a failing backup does not delete older ones even with keep = 1', async () => {
    const { ctx, dataDir } = setup({ keep: 1 });
    const good = await createBackup(ctx, { actorUserId: null });
    ctx.clock.advance(5000);
    await expect(
      createBackup(ctx, { actorUserId: null, hooks: { afterCopy: (f) => fs.writeFileSync(f, 'garbage') } }),
    ).rejects.toThrow();
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([path.basename(good.path)]);
  });

  it('builds the path from constants: a hostile data directory name cannot inject SQL or escape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-backup-'));
    dirs.push(root);
    const dataDir = path.join(root, "it's; DROP TABLE users; --");
    fs.mkdirSync(dataDir);
    const db = openDatabase(path.join(dataDir, 'darling.sqlite'));
    applyMigrations(db);
    const result = await createBackup({ db, clock: fixedClock(), config: testConfig({ dataDir }) }, { actorUserId: null });
    expect(path.dirname(result.path)).toBe(path.join(dataDir, 'backups'));
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM users')?.n).toBe(0);
  });
});

describe('verifyBackupFile', () => {
  it('rejects garbage, a truncated database and a missing file; never modifies the file', async () => {
    const { ctx, dataDir } = setup();
    const good = await createBackup(ctx, { actorUserId: null });
    const before = fs.readFileSync(good.path);
    expect(verifyBackupFile(good.path)).toEqual({ ok: true });
    expect(fs.readFileSync(good.path).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual([path.basename(good.path)]); // no -wal/-shm created by checking

    const garbage = path.join(dataDir, 'garbage.sqlite');
    fs.writeFileSync(garbage, 'this is not a database at all, just text'.repeat(50));
    expect(verifyBackupFile(garbage).ok).toBe(false);

    const truncated = path.join(dataDir, 'truncated.sqlite');
    fs.writeFileSync(truncated, before.subarray(0, Math.floor(before.length / 2)));
    expect(verifyBackupFile(truncated).ok).toBe(false);

    expect(verifyBackupFile(path.join(dataDir, 'missing.sqlite')).ok).toBe(false);
  });

  it('rejects a valid SQLite file that is not a Darling database', () => {
    const { dataDir } = setup();
    const other = path.join(dataDir, 'other.sqlite');
    const db = openDatabase(other);
    db.exec('CREATE TABLE t (x)');
    db.close();
    const r = verifyBackupFile(other);
    expect(r.ok).toBe(false);
  });
});

describe('listBackups / latestBackup', () => {
  it('returns [] / null when there is no backups directory', () => {
    const { dataDir } = setup();
    expect(listBackups(dataDir)).toEqual([]);
    expect(latestBackup(dataDir)).toBeNull();
  });
});

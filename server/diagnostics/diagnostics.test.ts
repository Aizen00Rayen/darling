import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup } from '../backup/backup';
import { createTestApp, type TestApp } from '../test/app';
import { collectDiagnostics, describeSmtp, ipVerdictFor } from './diagnostics';

let app: TestApp | undefined;
const dirs: string[] = [];
function dataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-diag-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  app?.close();
  app = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const H = (o: Record<string, string>) => new Headers(o);

describe('ipVerdictFor', () => {
  it('is "real" for a public address and "local_or_unknown" for loopback, private, link-local, CGNAT and unknown', () => {
    expect(ipVerdictFor('203.0.113.9')).toBe('real');
    expect(ipVerdictFor('2a01:4f8::1')).toBe('real');
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'unknown']) {
      expect(ipVerdictFor(ip)).toBe('local_or_unknown');
    }
  });
});

describe('describeSmtp', () => {
  it('returns host, port and TLS mode only, never credentials', () => {
    expect(describeSmtp('smtps://no-reply%40darling7.store:S3cret%23pass@smtp.hostinger.com:465')).toEqual({
      configured: true,
      host: 'smtp.hostinger.com',
      port: 465,
      tls: 'implicit',
    });
    expect(describeSmtp('smtp://u:p@smtp.example.test')).toEqual({ configured: true, host: 'smtp.example.test', port: 587, tls: 'starttls' });
    expect(describeSmtp('smtp://localhost:1025')).toEqual({ configured: true, host: 'localhost', port: 1025, tls: 'opportunistic' });
    expect(describeSmtp(undefined)).toEqual({ configured: false });
    expect(describeSmtp('not a url')).toEqual({ configured: false });
  });
});

describe('collectDiagnostics', () => {
  const secrets = {
    smtpUrl: 'smtps://mailer%40darling7.store:Sup3r-Secret-Pass@smtp.hostinger.com:465',
    setupToken: 's'.repeat(40),
    cronToken: 'c'.repeat(40),
  };

  it('reports the derived address, trusted hops and the raw proxy headers of the viewer own request', async () => {
    const dir = dataDir();
    app = createTestApp({ file: true, config: { dataDir: dir, trustedProxyHops: 1 } });
    const headers = H({
      'x-forwarded-for': '198.51.100.20, 203.0.113.9',
      'x-real-ip': '203.0.113.9',
      forwarded: 'for=203.0.113.9;proto=https',
      'cf-connecting-ip': '203.0.113.9',
    });
    const d = collectDiagnostics(app, headers, '203.0.113.9');
    expect(d.request).toEqual({
      clientIp: '203.0.113.9',
      trustedProxyHops: 1,
      verdict: 'real',
      headers: {
        'x-forwarded-for': '198.51.100.20, 203.0.113.9',
        'x-real-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.9;proto=https',
        'cf-connecting-ip': '203.0.113.9',
      },
    });
  });

  it('shows absent headers as null and flags a private address', () => {
    app = createTestApp({ file: true, config: { dataDir: dataDir() } });
    const d = collectDiagnostics(app, H({}), '10.0.0.4');
    expect(d.request.headers).toEqual({ 'x-forwarded-for': null, 'x-real-ip': null, forwarded: null, 'cf-connecting-ip': null });
    expect(d.request.verdict).toBe('local_or_unknown');
  });

  it('describes the runtime, data directory, database, migrations and backups', async () => {
    const dir = dataDir();
    app = createTestApp({ file: true, config: { dataDir: dir } });
    // the test DB lives elsewhere, so put a file where the app expects it to measure its size
    fs.writeFileSync(path.join(dir, 'darling.sqlite'), Buffer.alloc(4096));
    const before = collectDiagnostics(app, H({}), '203.0.113.9');
    expect(before.runtime.node).toBe(process.versions.node);
    expect(['node:sqlite', 'better-sqlite3']).toContain(before.runtime.sqliteDriver);
    expect(before.runtime.nodeEnv).toBe('test');
    expect(before.dataDir).toMatchObject({ path: dir, exists: true, writable: true, insideAppDir: false });
    expect(before.dataDir.freeBytes === null || before.dataDir.freeBytes > 0).toBe(true);
    expect(before.database.fileBytes).toBe(4096);
    expect(before.database.migrationsApplied).toBeGreaterThanOrEqual(3);
    expect(before.database.latestMigration).toMatch(/^\d{4}_/);
    expect(before.backups).toEqual({ count: 0, latest: null, keep: 14 });

    const made = await createBackup(app, { actorUserId: null });
    const after = collectDiagnostics(app, H({}), '203.0.113.9');
    expect(after.backups.count).toBe(1);
    expect(after.backups.latest).toMatchObject({ name: path.basename(made.path), bytes: made.bytes });
    expect(typeof after.backups.latest?.at).toBe('number');
  });

  it('warns when the data directory is missing, unwritable or inside the application directory', () => {
    app = createTestApp({ config: { dataDir: path.join(os.tmpdir(), 'darling-diag-does-not-exist') } });
    expect(collectDiagnostics(app, H({}), '1.1.1.1').dataDir).toMatchObject({ exists: false, writable: false });
    app.close();
    app = createTestApp({ config: { dataDir: path.join(process.cwd(), '.data') } });
    expect(collectDiagnostics(app, H({}), '1.1.1.1').dataDir.insideAppDir).toBe(true);
  });

  it('reports configuration flags without any secret value', () => {
    app = createTestApp({
      file: true,
      config: { dataDir: dataDir(), appOrigin: 'https://darling7.store', cookieSecure: true, ...secrets, mailFrom: 'DARLING* <no-reply@darling7.store>' },
    });
    const d = collectDiagnostics(app, H({}), '203.0.113.9');
    expect(d.config).toMatchObject({
      appOrigin: 'https://darling7.store',
      cookieSecure: true,
      smtp: { configured: true, host: 'smtp.hostinger.com', port: 465, tls: 'implicit' },
      mailFromSet: true,
      cronTokenSet: true,
      setupTokenSet: true,
    });
    const text = JSON.stringify(d);
    for (const secret of ['Sup3r-Secret-Pass', secrets.setupToken, secrets.cronToken, 'mailer%40', Buffer.alloc(32, 1).toString('base64')]) {
      expect(text).not.toContain(secret);
    }
  });

  it('reports uptime from the process clock', () => {
    app = createTestApp({ file: true, config: { dataDir: dataDir() } });
    const d = collectDiagnostics(app, H({}), '203.0.113.9');
    expect(d.runtime.uptimeSeconds).toBeGreaterThan(0);
    expect(d.runtime.startedAt).toBeLessThanOrEqual(app.clock.now());
  });
});

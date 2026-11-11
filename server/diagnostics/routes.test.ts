import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, login, seedUser, totpCodeAt, type TestApp } from '../test/app';

let app: TestApp;
let dir: string;
const SMTP_URL = 'smtps://mailer%40darling7.store:Sup3r-Secret-Pass@smtp.hostinger.com:465';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darling-diagroutes-'));
  app = createTestApp({ file: true, config: { dataDir: dir, smtpUrl: SMTP_URL, setupToken: 's'.repeat(40), cronToken: 'c'.repeat(40) } });
});
afterEach(() => {
  vi.restoreAllMocks();
  app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function owner() {
  const u = await seedUser(app, { role: 'super_manager', isOwner: true, totp: true, fullName: 'Nour Owner' });
  const cookie = await login(app, u.email, u.password, { totpCode: totpCodeAt(u.totpSecret!, app.clock.now()) });
  return { cookie, id: u.id, email: u.email };
}
async function plainManager() {
  const u = await seedUser(app, { role: 'super_manager', permissions: ['settings.manage', 'audit.read'], totp: true });
  return login(app, u.email, u.password, { totpCode: totpCodeAt(u.totpSecret!, app.clock.now()) });
}

describe('GET /api/diagnostics', () => {
  it('shows the owner the address and raw proxy headers of their own request', async () => {
    const o = await owner();
    const res = await app.call('/api/diagnostics', {
      cookie: o.cookie,
      ip: '203.0.113.9',
      headers: { 'X-Real-IP': '203.0.113.9', Forwarded: 'for=203.0.113.9', 'CF-Connecting-IP': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request).toMatchObject({
      clientIp: '203.0.113.9',
      trustedProxyHops: 1,
      verdict: 'real',
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', forwarded: 'for=203.0.113.9', 'cf-connecting-ip': '203.0.113.9' },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('flags a private address', async () => {
    const o = await owner();
    const body = await (await app.call('/api/diagnostics', { cookie: o.cookie, ip: '10.9.8.7' })).json();
    expect(body.request.verdict).toBe('local_or_unknown');
  });

  it('never contains a secret', async () => {
    const o = await owner();
    const text = await (await app.call('/api/diagnostics', { cookie: o.cookie })).text();
    for (const secret of ['Sup3r-Secret-Pass', 's'.repeat(40), 'c'.repeat(40), 'mailer%40', Buffer.alloc(32, 1).toString('base64'), o.cookie.split('=')[1]!]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text).config.smtp).toEqual({ configured: true, host: 'smtp.hostinger.com', port: 465, tls: 'implicit' });
  });

  it('is owner-only', async () => {
    expect((await app.call('/api/diagnostics')).status).toBe(401);
    expect((await app.call('/api/diagnostics', { cookie: await plainManager() })).status).toBe(403);
  });
});

describe('POST /api/diagnostics/test-mail', () => {
  it('sends a test mail to the owner own address only, and audits it', async () => {
    const o = await owner();
    const res = await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: o.cookie, body: { to: 'victim@example.test' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, to: o.email });
    expect(app.mailer.sent).toHaveLength(1);
    expect(app.mailer.sent[0]).toMatchObject({ to: o.email, subject: 'DARLING* : e-mail de test' });
    const rows = app.db.all<{ actor_user_id: string }>("SELECT actor_user_id FROM audit_log WHERE action = 'diagnostics.test_mail_sent'");
    expect(rows).toEqual([{ actor_user_id: o.id }]);
  });

  it('is limited to 3 an hour', async () => {
    const o = await owner();
    for (let i = 0; i < 3; i += 1) expect((await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: o.cookie })).status).toBe(200);
    const res = await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: o.cookie });
    expect(res.status).toBe(429);
    expect(app.mailer.sent).toHaveLength(3);
  });

  it('reports an SMTP failure by its code only, never its message, and audits the failure', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => (written.push(String(chunk)), true)) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => (written.push(String(chunk)), true)) as never);
    const o = await owner();
    app.mailer.send = async () => {
      throw Object.assign(new Error('535 5.7.8 Authentication failed for mailer@darling7.store from smtp.hostinger.com'), { code: 'EAUTH' });
    };
    const res = await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: o.cookie });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ code: 'mail_failed', reason: 'EAUTH' });
    expect(text).not.toContain('hostinger');
    expect(written.join('')).toContain('diagnostics.test_mail_failed');
    expect(written.join('')).not.toContain('mailer@darling7.store'); // the SMTP message (with an address) never reaches the log
    expect(app.db.get<{ reason: string }>("SELECT reason FROM audit_log WHERE action = 'diagnostics.test_mail_failed'")?.reason).toBe('EAUTH');
  });

  it('answers 409 when production has no SMTP_URL', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    app.close();
    app = createTestApp({ file: true, config: { dataDir: dir, nodeEnv: 'production', isProduction: true, smtpUrl: undefined } });
    const o = await owner();
    const res = await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: o.cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'smtp_not_configured' });
  });

  it('is owner-only and needs the CSRF headers', async () => {
    expect((await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: await plainManager() })).status).toBe(403);
    const o = await owner();
    expect((await app.call('/api/diagnostics/test-mail', { method: 'POST', cookie: o.cookie, headers: { 'X-Requested-With': null } })).status).toBe(403);
    expect(app.mailer.sent).toHaveLength(0);
  });
});

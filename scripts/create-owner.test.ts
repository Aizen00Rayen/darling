import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryMailer } from '../server/mail/mailer';
import { createTestApp, DEFAULT_PASSWORD, seedUser, type TestApp } from '../server/test/app';
import { main } from './create-owner';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => app.close());

const ENV = { NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:3000' } as NodeJS.ProcessEnv;

async function run(argv: string[], mailer = memoryMailer()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, ENV, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), deps: { db: app.db, clock: app.clock, mailer } });
  return { code, out: out.join(''), err: err.join(''), mailer };
}

describe('create-owner CLI', () => {
  it('creates an invited owner, prints the link, mails it, and the link activates the account', async () => {
    const r = await run(['--email', 'Boss@Example.test', '--name', 'The Boss']);
    expect(r.code).toBe(0);
    const link = /(http:\/\/localhost:3000\/invitation\?token=[A-Za-z0-9_-]{43})/.exec(r.out)?.[1];
    expect(link).toBeTruthy();
    expect(r.out).toContain('valid 7 days');
    expect(r.mailer.sent).toHaveLength(1);
    expect(r.mailer.sent[0]?.to).toBe('boss@example.test');
    const row = app.db.get<{ status: string; is_owner: number; role: string; password_hash: string | null }>("SELECT * FROM users WHERE email = 'boss@example.test'");
    expect(row).toMatchObject({ status: 'invited', is_owner: 1, role: 'super_manager', password_hash: null });
    expect(app.db.get<{ action: string; actor_user_id: string | null }>('SELECT * FROM audit_log')).toMatchObject({ action: 'user.created', actor_user_id: null });

    const token = link?.split('token=')[1];
    expect((await app.call('/api/auth/invite/accept', { body: { token, password: DEFAULT_PASSWORD } })).status).toBe(204);
  });

  it('prints no password and no secret, only the link', async () => {
    const r = await run(['--email', 'boss@example.test', '--name', 'The Boss']);
    expect(r.out + r.err).not.toMatch(/password|secret|scrypt/i);
  });

  it('refuses when an owner exists, unless --force', async () => {
    await seedUser(app, { role: 'super_manager', isOwner: true });
    const refused = await run(['--email', 'boss@example.test', '--name', 'The Boss']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--force');
    expect(refused.out).toBe('');
    expect(app.db.all('SELECT 1 FROM users')).toHaveLength(1);
    const forced = await run(['--email', 'boss@example.test', '--name', 'The Boss', '--force']);
    expect(forced.code).toBe(0);
    expect(app.db.all('SELECT 1 FROM users')).toHaveLength(2);
  });

  it('re-run with the same email while the owner is still invited: prints a NEW link, mails it, exit 0', async () => {
    const a = await run(['--email', 'boss@example.test', '--name', 'The Boss']);
    const b = await run(['--email', 'boss@example.test', '--name', 'The Boss']);
    expect(b.code).toBe(0);
    const link = (t: string) => /token=([A-Za-z0-9_-]{43})/.exec(t)?.[1];
    expect(link(b.out)).toBeTruthy();
    expect(link(b.out)).not.toBe(link(a.out));
    expect(b.out).toContain('re-issued');
    expect(b.mailer.sent).toHaveLength(1);
    expect(app.db.all('SELECT 1 FROM users')).toHaveLength(1);
  });

  it('refuses an existing email, even with --force, without echoing the address', async () => {
    await seedUser(app, { role: 'affiliate', email: 'taken@example.test' });
    const r = await run(['--email', 'taken@example.test', '--name', 'The Boss', '--force']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already exists');
    expect(r.err).not.toContain('taken@example.test');
  });

  it('reports a mail failure as a warning (exit 0, link still printed, address not echoed)', async () => {
    const r = await run(['--email', 'boss@example.test', '--name', 'The Boss'], {
      async send() {
        throw new Error('cannot reach smtp for boss@example.test');
      },
    } as never);
    expect(r.code).toBe(0);
    expect(r.out).toContain('/invitation?token=');
    expect(r.err).toContain('could not be sent');
    expect(r.err).not.toContain('boss@example.test');
  });

  it.each([
    [[]],
    [['--email', 'boss@example.test']],
    [['--name', 'The Boss']],
    [['--email', 'nope', '--name', 'The Boss']],
    [['--email', 'boss@example.test', '--name', 'X']],
    [['--email', 'boss@example.test', '--name', 'The Boss', '--bogus']],
    [['stray', '--email', 'boss@example.test', '--name', 'The Boss']],
  ])('rejects bad arguments %j with exit code 1 and creates nothing', async (argv) => {
    const r = await run(argv as string[]);
    expect(r.code).toBe(1);
    expect(r.err.length).toBeGreaterThan(0);
    expect(app.db.all('SELECT 1 FROM users')).toHaveLength(0);
  });

  it('reports configuration problems by key name only', async () => {
    const err: string[] = [];
    const code = await main(['--email', 'boss@example.test', '--name', 'The Boss'], { NODE_ENV: 'test', SETUP_TOKEN: 'secret-short' } as NodeJS.ProcessEnv, { stdout: () => {}, stderr: (t) => err.push(t), deps: { db: app.db, clock: app.clock, mailer: memoryMailer() } });
    expect(code).toBe(1);
    expect(err.join('')).toContain('SETUP_TOKEN');
    expect(err.join('')).not.toContain('secret-short');
  });
});

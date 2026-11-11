import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, DEFAULT_PASSWORD, login, seedUser, type TestApp } from '../test/app';
import { createInvitedOwner, CreateOwnerError, setupAvailable, tokenMatches } from './first-owner';
import { settleBackgroundWork } from '../mail/outbox';

const TOKEN = 'setup-token-0123456789abcdef-0123456789abcdef';
let app: TestApp;
afterEach(() => {
  app?.close();
  vi.restoreAllMocks();
});

const json = async (res: Response) => (await res.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const valid = (extra: Record<string, unknown> = {}) => ({ token: TOKEN, fullName: 'Amel Owner', email: 'Owner@Example.test', password: DEFAULT_PASSWORD, ...extra });
const setup = (body: unknown, extra: { ip?: string } = {}) => app.call('/api/setup', { method: 'POST', body: body as object, ...extra });
const users = () => app.db.all<{ id: string; email: string; role: string; status: string; is_owner: number; password_hash: string | null; full_name: string }>('SELECT * FROM users');
const audits = () => app.db.all<{ actor_user_id: string | null; action: string; entity_id: string; reason: string | null; before: string | null; after: string | null }>('SELECT * FROM audit_log ORDER BY id');

describe('tokenMatches', () => {
  it('compares in constant time and only accepts the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN} `, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.toUpperCase(), TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
  });
});

describe('POST /api/setup', () => {
  describe('when SETUP_TOKEN is not set', () => {
    beforeEach(() => {
      app = createTestApp();
    });

    it('is disabled: 404 not_found, whatever is sent, and nothing is created', async () => {
      for (const body of [valid(), {}, { token: '' }]) {
        const res = await setup(body);
        expect(res.status).toBe(404);
        expect(await json(res)).toEqual({ code: 'not_found' });
      }
      expect(users()).toHaveLength(0);
      expect(setupAvailable(app)).toBe(false);
    });
  });

  describe('when SETUP_TOKEN is set and no user exists', () => {
    beforeEach(() => {
      app = createTestApp({ config: { setupToken: TOKEN } });
    });

    it('creates an ACTIVE owner with a hashed password, audits it, and the owner can log in and is asked to enrol 2FA', async () => {
      expect(setupAvailable(app)).toBe(true);
      const res = await setup(valid());
      expect(res.status).toBe(204);
      const [owner] = users();
      expect(users()).toHaveLength(1);
      expect(owner).toMatchObject({ email: 'owner@example.test', role: 'super_manager', status: 'active', is_owner: 1, full_name: 'Amel Owner' });
      expect(owner?.password_hash).toMatch(/^scrypt\$/);
      expect(app.db.all('SELECT * FROM user_permissions')).toHaveLength(0);

      const [entry, ...rest] = audits();
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({ actor_user_id: null, action: 'user.created', entity_id: owner?.id, reason: 'first-run setup' });
      const text = JSON.stringify(audits());
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(DEFAULT_PASSWORD);
      expect(text).not.toMatch(/scrypt|hash/i);

      const cookie = await login(app, 'owner@example.test', DEFAULT_PASSWORD);
      const me = await json(await app.call('/api/auth/me', { cookie }));
      expect(me).toMatchObject({ isOwner: true, role: 'super_manager', mustEnroll2fa: true });
      expect(setupAvailable(app)).toBe(false);
    });

    it('answers 404 once any user exists (the page is closed for good)', async () => {
      expect((await setup(valid())).status).toBe(204);
      const again = await setup(valid({ email: 'second@example.test' }));
      expect(again.status).toBe(404);
      expect(await json(again)).toEqual({ code: 'not_found' });
      expect(users()).toHaveLength(1);
    });

    it('answers 404 when a user exists that was created another way (even an invited one)', async () => {
      await seedUser(app, { role: 'affiliate', status: 'invited' });
      expect((await setup(valid())).status).toBe(404);
      expect(users()).toHaveLength(1);
    });

    it('refuses a wrong token (403 invalid_setup_token) and creates nothing', async () => {
      for (const token of ['wrong', `${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase(), ' ' + TOKEN]) {
        const res = await setup(valid({ token }));
        expect(res.status, token).toBe(403);
        expect(await json(res)).toEqual({ code: 'invalid_setup_token' });
      }
      expect(users()).toHaveLength(0);
      expect(audits()).toHaveLength(0);
    });

    it('checks the token before the password policy, so a caller without it learns nothing about the form', async () => {
      const res = await setup(valid({ token: 'nope', password: 'x' }));
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'invalid_setup_token' });
    });

    it('enforces the password policy and the field rules (400 validation, nothing created)', async () => {
      const weak = await setup(valid({ password: 'short' }));
      expect(weak.status).toBe(400);
      expect(Object.keys((await json(weak)).errors)).toEqual(['password']);
      const common = await setup(valid({ password: 'password1234' }));
      expect(common.status).toBe(400);
      for (const bad of [{ email: 'nope' }, { fullName: 'A' }, { password: undefined }, { token: undefined }]) {
        const res = await setup(valid(bad));
        expect(res.status).toBe(400);
        expect((await json(res)).code).toBe('validation');
      }
      expect(users()).toHaveLength(0);
      // none of this used up the (single) chance: the right form still works
      expect((await setup(valid())).status).toBe(204);
    });

    it('is rate limited to 5 attempts per 15 minutes per address, right token or wrong', async () => {
      const ip = '198.51.100.7';
      for (let i = 0; i < 5; i += 1) expect((await setup(valid({ token: 'wrong' }), { ip })).status).toBe(403);
      const limited = await setup(valid(), { ip });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      expect(users()).toHaveLength(0);
      expect((await setup(valid(), { ip: '198.51.100.8' })).status).toBe(204); // another address is unaffected
    });

    it('needs the CSRF headers like every other state-changing route', async () => {
      const res = await app.call('/api/setup', { method: 'POST', body: valid(), headers: { 'X-Requested-With': null } });
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ code: 'csrf' });
      expect(users()).toHaveLength(0);
    });

    it('only accepts POST', async () => {
      expect((await app.call('/api/setup', { method: 'GET' })).status).toBe(405);
    });

    it('never puts the token in a response or in the logs', async () => {
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (written.push(String(chunk)), true)) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => (written.push(String(chunk)), true)) as never);
      const bodies: string[] = [];
      for (const body of [valid({ token: 'wrong-token-value-1234567890' }), valid({ password: 'x' }), valid(), valid()]) {
        const res = await setup(body);
        bodies.push(await res.text());
      }
      expect(bodies.join('\n')).not.toContain(TOKEN);
      expect(bodies.join('\n')).not.toContain('wrong-token-value');
      expect(written.join('\n')).not.toContain(TOKEN);
      expect(written.join('\n')).not.toContain('wrong-token-value');
      expect(written.join('\n')).not.toContain(DEFAULT_PASSWORD);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of several simultaneous setups win', async () => {
      app = createTestApp({ file: true, connections: 4, config: { setupToken: TOKEN } });
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((n) => setup(valid({ email: `${n}@example.test`, fullName: `Owner ${n.toUpperCase()}` }))),
      );
      expect(results.map((r) => r.status).sort()).toEqual([204, 404, 404, 404]);
      expect(users()).toHaveLength(1);
      expect(users()[0]).toMatchObject({ is_owner: 1, status: 'active' });
      expect(audits().filter((a) => a.action === 'user.created')).toHaveLength(1);
    });

    it('lets exactly one win when two submit the same email', async () => {
      app = createTestApp({ file: true, connections: 3, config: { setupToken: TOKEN } });
      const results = await Promise.all([setup(valid()), setup(valid())]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
      expect(users()).toHaveLength(1);
    });
  });
});

describe('createInvitedOwner (the CLI core)', () => {
  beforeEach(() => {
    app = createTestApp();
  });
  const deps = () => ({ db: app.db, clock: app.clock, config: app.config });

  it('creates an invited owner with no password, an invite link that works, and an audit row (actor null)', async () => {
    const { userId, link } = createInvitedOwner(deps(), { email: ' Boss@Example.test ', fullName: 'The Boss', force: false });
    const [row] = users();
    expect(row).toMatchObject({ id: userId, email: 'boss@example.test', role: 'super_manager', status: 'invited', is_owner: 1, password_hash: null });
    expect(link).toMatch(/^http:\/\/localhost:3000\/invitation\?token=[A-Za-z0-9_-]{43}$/);
    const [entry] = audits();
    expect(entry).toMatchObject({ actor_user_id: null, action: 'user.created', entity_id: userId, reason: 'cli create-owner' });
    expect(entry?.after).toContain('"isOwner":true');
    expect(JSON.stringify(audits())).not.toContain(link.split('token=')[1]);

    const token = link.split('token=')[1];
    const accepted = await app.call('/api/auth/invite/accept', { body: { token, password: DEFAULT_PASSWORD } });
    expect(accepted.status).toBe(204);
    expect(users()[0]?.status).toBe('active');
    await settleBackgroundWork();
  });

  it('refuses when any owner exists (whatever its status) unless forced', async () => {
    await seedUser(app, { role: 'super_manager', isOwner: true, status: 'suspended' });
    expect(() => createInvitedOwner(deps(), { email: 'x@example.test', fullName: 'X Person', force: false })).toThrow(expect.objectContaining({ code: 'owner_exists' }));
    expect(users()).toHaveLength(1);
    expect(createInvitedOwner(deps(), { email: 'x@example.test', fullName: 'X Person', force: true }).link).toContain('/invitation?token=');
    expect(users()).toHaveLength(2);
  });

  it('refuses an existing email, even with --force and in another case', async () => {
    await seedUser(app, { role: 'affiliate', email: 'taken@example.test' });
    for (const force of [false, true]) {
      expect(() => createInvitedOwner(deps(), { email: 'TAKEN@example.test', fullName: 'X Person', force })).toThrow(expect.objectContaining({ code: 'email_taken' }));
    }
    expect(users()).toHaveLength(1);
  });

  it('refuses invalid arguments', () => {
    for (const args of [{ email: 'nope', fullName: 'X Person' }, { email: 'x@example.test', fullName: 'X' }]) {
      expect(() => createInvitedOwner(deps(), { ...args, force: false })).toThrow(CreateOwnerError);
    }
    expect(users()).toHaveLength(0);
  });
});

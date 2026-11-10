import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, authTokens, users } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import { createTestContext, csrfHeaders, freshAddress, login, type TestContext } from '../../test/context';
import { CreateOwnerError, createOwner, main } from './create-owner';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

const EMAIL = 'Founder@Example.test';
const NAME = '  Amel Founder  ';
const LINK = /^http:\/\/localhost:3000\/invitation\?token=([A-Za-z0-9_-]{20,})$/;

const deps = (extra: { mailer?: Mailer; warn?: (m: string) => void } = {}) => ({
  db: ctx.db,
  mailer: extra.mailer ?? ctx.mailer,
  config: ctx.config,
  clock: ctx.clock,
  ...(extra.warn ? { warn: extra.warn } : {}),
});
const args = (extra: Partial<{ email: string; name: string; force: boolean }> = {}) => ({
  email: EMAIL,
  name: NAME,
  force: false,
  ...extra,
});

const allUsers = () => ctx.db.select().from(users);
const throwingMailer: Mailer = {
  async send() {
    throw new Error('connect ECONNREFUSED while sending to founder@example.test');
  },
};

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(CreateOwnerError);
    return (err as CreateOwnerError).code;
  }
  throw new Error('expected createOwner to throw');
}

describe('createOwner', () => {
  it('creates one invited owner and returns an invitation link', async () => {
    const { link } = await createOwner(deps(), args());
    expect(link).toMatch(LINK);

    const rows = await allUsers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'founder@example.test',
      fullName: 'Amel Founder',
      role: 'super_manager',
      isOwner: true,
      status: 'invited',
      passwordHash: null,
      totpEnabled: false,
    });
    const tokens = await ctx.db.select().from(authTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ userId: rows[0]?.id, type: 'invite', usedAt: null });
    expect(tokens[0]?.expiresAt.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('mails the same link to the normalised address', async () => {
    const { link } = await createOwner(deps(), args());
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]?.to).toBe('founder@example.test');
    expect(ctx.mailer.sent[0]?.text).toContain(link);
  });

  it('issues a token the invitation flow accepts, after which the owner can sign in', async () => {
    const { link } = await createOwner(deps(), args());
    const token = LINK.exec(link)?.[1];
    const password = 'Rose-gloss-2026';
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/invite/accept',
      headers: csrfHeaders(ctx),
      remoteAddress: freshAddress(),
      payload: { token, password },
    });
    expect(accepted.statusCode).toBe(204);

    const cookie = await login(ctx, 'founder@example.test', password);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { ...csrfHeaders(ctx), cookie },
      remoteAddress: freshAddress(),
    });
    expect(me.json()).toMatchObject({ email: 'founder@example.test', role: 'super_manager', isOwner: true });
    const [row] = await allUsers();
    expect(row?.status).toBe('active');
  });

  it('audits the creation with no actor and the CLI reason', async () => {
    await createOwner(deps(), args());
    const [user] = await allUsers();
    const entries = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'user.created'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorUserId: null,
      entityType: 'user',
      entityId: user?.id,
      reason: 'cli create-owner',
      before: null,
    });
    expect(entries[0]?.after).toMatchObject({
      email: 'founder@example.test',
      role: 'super_manager',
      status: 'invited',
      isOwner: true,
    });
    expect(JSON.stringify(entries[0])).not.toMatch(/token|hash|password/i);
  });

  it('refuses when an owner exists, whatever its status, and leaves everything as it was', async () => {
    await createOwner(deps(), args());
    expect(await codeOf(createOwner(deps(), args({ email: 'other@example.test' })))).toBe('owner_exists');
    expect(await allUsers()).toHaveLength(1);
    expect(ctx.mailer.sent).toHaveLength(1);

    for (const status of ['active', 'suspended', 'deactivated'] as const) {
      await ctx.db.update(users).set({ status });
      expect(await codeOf(createOwner(deps(), args({ email: 'other@example.test' })))).toBe('owner_exists');
    }
    expect(await allUsers()).toHaveLength(1);
  });

  it('creates another owner with force', async () => {
    await createOwner(deps(), args());
    const { link } = await createOwner(deps(), args({ email: 'second@example.test', name: 'Second Owner', force: true }));
    expect(link).toMatch(LINK);
    const owners = (await allUsers()).filter((u) => u.isOwner);
    expect(owners.map((o) => o.email).sort()).toEqual(['founder@example.test', 'second@example.test']);
  });

  it('refuses an email that is already taken, even with force, case-insensitively', async () => {
    await ctx.db.insert(users).values({
      email: 'taken@example.test',
      fullName: 'Someone',
      role: 'affiliate',
      status: 'active',
    });
    expect(await codeOf(createOwner(deps(), args({ email: 'TAKEN@example.test' })))).toBe('email_taken');
    expect(await codeOf(createOwner(deps(), args({ email: 'taken@example.test', force: true })))).toBe('email_taken');
    expect(await allUsers()).toHaveLength(1);
    expect(await ctx.db.select().from(auditLog)).toHaveLength(0);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it.each([
    ['a missing email', { email: '' }],
    ['a malformed email', { email: 'not-an-email' }],
    ['a name that is too short', { name: ' A ' }],
    ['a name that is too long', { name: 'x'.repeat(121) }],
  ])('rejects %s with invalid_args', async (_what, extra) => {
    expect(await codeOf(createOwner(deps(), args(extra)))).toBe('invalid_args');
    expect(await allUsers()).toHaveLength(0);
  });

  it('lets exactly one of two simultaneous runs create the owner', async () => {
    const results = await Promise.allSettled([
      createOwner(deps(), args({ email: 'a@example.test' })),
      createOwner(deps(), args({ email: 'b@example.test' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect((failed as PromiseRejectedResult).reason).toMatchObject({ code: 'owner_exists' });
    expect(await allUsers()).toHaveLength(1);
  });

  it('still returns the link when the mail cannot be sent, and warns without the address', async () => {
    const warnings: string[] = [];
    const { link } = await createOwner(deps({ mailer: throwingMailer, warn: (m) => warnings.push(m) }), args());
    expect(link).toMatch(LINK);
    expect(await allUsers()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/founder|example\.test|ECONNREFUSED/i);
  });
});

type Io = { out: string; err: string };
function io(mailer?: Mailer) {
  const captured: Io = { out: '', err: '' };
  return {
    captured,
    io: {
      stdout: (text: string) => void (captured.out += text),
      stderr: (text: string) => void (captured.err += text),
      ...(mailer ? { mailer } : {}),
      clock: ctx.clock,
    },
  };
}

function envFor(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    API_PORT: '4000',
    APP_ORIGIN: ctx.config.appOrigin,
    DATABASE_URL: ctx.config.databaseUrl,
    DATABASE_OWNER_URL: ctx.config.databaseOwnerUrl,
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    ENCRYPTION_KEY: ctx.config.encryptionKey.toString('base64'),
    TOKEN_PEPPER: ctx.config.tokenPepper.toString('base64'),
    // Nothing listens here: a mail attempt through the real transport fails fast.
    SMTP_URL: 'smtp://127.0.0.1:1',
    MAIL_FROM: ctx.config.mailFrom,
    ...overrides,
  };
}

const ARGV = ['--email', EMAIL, '--name', NAME];

describe('main', () => {
  it('exits 0 and prints the success line and the link, and only that', async () => {
    const { captured, io: streams } = io(ctx.mailer);
    expect(await main(ARGV, envFor(), streams)).toBe(0);
    const lines = captured.out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(LINK);
    expect(captured.err).toBe('');
    expect(captured.out).not.toMatch(/hash|password|secret|argon/i);
    const [row] = await allUsers();
    expect(row).toMatchObject({ status: 'invited', isOwner: true });
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]?.text).toContain(lines[1]);
  });

  it('exits 1 with an error on stderr and nothing on stdout when an owner exists', async () => {
    await main(ARGV, envFor(), io(ctx.mailer).io);
    const { captured, io: streams } = io(ctx.mailer);
    expect(await main(['--email', 'other@example.test', '--name', 'Other Person'], envFor(), streams)).toBe(1);
    expect(captured.out).toBe('');
    expect(captured.err).toMatch(/owner/i);
    expect(captured.err).toMatch(/--force/);
    expect(captured.err).not.toMatch(/token=/);
    expect(await allUsers()).toHaveLength(1);
  });

  it('exits 0 with --force even when an owner exists', async () => {
    await main(ARGV, envFor(), io(ctx.mailer).io);
    const { captured, io: streams } = io(ctx.mailer);
    expect(await main(['--email', 'other@example.test', '--name', 'Other Person', '--force'], envFor(), streams)).toBe(0);
    expect(captured.out).toMatch(/invitation\?token=/);
    expect((await allUsers()).filter((u) => u.isOwner)).toHaveLength(2);
  });

  it('exits 1 when the email already exists', async () => {
    await ctx.db.insert(users).values({ email: 'founder@example.test', fullName: 'Someone', role: 'affiliate', status: 'active' });
    const { captured, io: streams } = io(ctx.mailer);
    expect(await main(['--email', EMAIL, '--name', 'Amel Founder', '--force'], envFor(), streams)).toBe(1);
    expect(captured.out).toBe('');
    expect(captured.err).toMatch(/already/i);
    expect(captured.err).not.toMatch(/founder@/i);
  });

  it.each([
    ['no arguments', []],
    ['a missing email', ['--name', 'Amel Founder']],
    ['a missing name', ['--email', 'founder@example.test']],
    ['a malformed email', ['--email', 'nope', '--name', 'Amel Founder']],
    ['a name that is too short', ['--email', 'founder@example.test', '--name', 'A']],
    ['an unknown option', ['--email', 'founder@example.test', '--name', 'Amel Founder', '--admin']],
    ['a stray positional argument', ['--email', 'founder@example.test', '--name', 'Amel Founder', 'extra']],
  ])('exits 1 with the usage on stderr for %s, touching nothing', async (_what, argv) => {
    const { captured, io: streams } = io(ctx.mailer);
    expect(await main(argv, envFor(), streams)).toBe(1);
    expect(captured.out).toBe('');
    expect(captured.err).toMatch(/Usage:/);
    expect(captured.err).toMatch(/create-owner --email/);
    expect(await allUsers()).toHaveLength(0);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('exits 0 and still prints the link when the mail fails, with a warning that has no address', async () => {
    const { captured, io: streams } = io(throwingMailer);
    expect(await main(ARGV, envFor(), streams)).toBe(0);
    expect(captured.out).toMatch(/invitation\?token=/);
    expect(captured.err).toMatch(/warning/i);
    expect(captured.err).not.toMatch(/founder|example\.test|ECONNREFUSED/i);
    expect(await allUsers()).toHaveLength(1);
  });

  it('uses the real SMTP transport by default: an unreachable server is a warning, not a failure', async () => {
    const captured: Io = { out: '', err: '' };
    const code = await main(ARGV, envFor(), {
      stdout: (t) => void (captured.out += t),
      stderr: (t) => void (captured.err += t),
    });
    expect(code).toBe(0);
    expect(captured.out).toMatch(/invitation\?token=/);
    expect(captured.err).toMatch(/warning/i);
    expect(captured.err).not.toMatch(/founder|example\.test|127\.0\.0\.1|ECONNREFUSED/i);
  });

  it('reports an invalid configuration without echoing values and exits 1', async () => {
    const { captured, io: streams } = io(ctx.mailer);
    expect(await main(ARGV, envFor({ DATABASE_URL: 'postgres://user:hunter2@bad host/db', SMTP_URL: undefined }), streams)).toBe(1);
    expect(captured.out).toBe('');
    expect(captured.err).toMatch(/DATABASE_URL|SMTP_URL/);
    expect(captured.err).not.toContain('hunter2');
  });
});

describe('running the file directly', () => {
  it('creates the owner, prints the link and exits 0; a second run exits 1', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/create-owner.ts', ...ARGV], {
        cwd: root,
        env: { PATH: process.env.PATH, ...envFor() } as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 60_000,
      });
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout.trimEnd().split('\n')).toHaveLength(2);
    expect(first.stdout).toMatch(/invitation\?token=/);
    expect(first.stderr).toMatch(/warning/i);

    const second = run();
    expect(second.status).toBe(1);
    expect(second.stdout).toBe('');
    expect(second.stderr).toMatch(/owner/i);
    expect(await allUsers()).toHaveLength(1);
  });
});

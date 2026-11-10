import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@darling/shared';
import { sessions, settings, userPermissions, users } from '../db/schema';
import { createTestContext, login, seedUser, type TestContext } from '../../test/context';

const PUBLIC = { kind: 'public' } as const;

function probes(app: FastifyInstance) {
  app.get('/t/any', { config: { access: { kind: 'authenticated' } } }, async (req) => ({
    userId: req.auth?.userId ?? null,
  }));
  app.get('/t/orders', { config: { access: { kind: 'permission', permission: 'orders.read' } } }, async () => ({
    reached: true,
  }));
  app.get('/t/owner', { config: { access: { kind: 'owner' } } }, async () => ({ reached: true }));
  app.get('/t/public', { config: { access: PUBLIC } }, async (req) => ({ authenticated: req.auth !== null }));
}

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({ build: { extend: probes } });
});
afterEach(async () => {
  await ctx.close();
});

function get(url: string, cookie?: string) {
  return ctx.app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });
}

describe('auth plugin: who the request is', () => {
  it('gives an owner every one of the 14 permissions in catalogue order', async () => {
    const owner = await seedUser(ctx, { role: 'super_manager', isOwner: true, totp: true });
    const { totpCodeAt } = await import('../../test/context');
    const cookie = await login(ctx, owner.email, owner.password, totpCodeAt(owner.totpSecret as string, ctx.clock.now));
    const me = (await get('/api/auth/me', cookie)).json();
    expect(PERMISSIONS).toHaveLength(14);
    expect(me.permissions).toEqual([...PERMISSIONS]);
    expect((await get('/t/orders', cookie)).statusCode).toBe(200);
    expect((await get('/t/owner', cookie)).statusCode).toBe(200);
  });

  it('gives a Super Manager exactly the granted permissions, in catalogue order', async () => {
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['audit.read', 'orders.read', 'users.manage'] });
    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
    const cookie = await login(ctx, sm.email, sm.password);
    expect((await get('/api/auth/me', cookie)).json().permissions).toEqual(['users.manage', 'orders.read', 'audit.read']);
    expect((await get('/t/orders', cookie)).statusCode).toBe(200);
    expect((await get('/t/owner', cookie)).statusCode).toBe(403);
  });

  it('ignores stray permission rows on an influenceuse or a sous-manager', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate', permissions: [...PERMISSIONS] });
    const sub = await seedUser(ctx, { role: 'sub_manager', permissions: ['orders.read'] });
    for (const user of [aff, sub]) {
      const cookie = await login(ctx, user.email, user.password);
      expect((await get('/api/auth/me', cookie)).json().permissions).toEqual([]);
      const orders = await get('/t/orders', cookie);
      expect(orders.statusCode).toBe(403);
      expect(orders.json()).toEqual({ code: 'forbidden' });
    }
  });

  it('treats a request without a session, or with a stale one, as anonymous', async () => {
    expect((await get('/t/public')).json()).toEqual({ authenticated: false });
    expect((await get('/t/public', 'dl_session=' + 'a'.repeat(43))).json()).toEqual({ authenticated: false });
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password);
    expect((await get('/t/public', cookie)).json()).toEqual({ authenticated: true });
  });
});

describe('auth plugin: reads the database on every request', () => {
  it.each(['invited', 'suspended', 'deactivated'] as const)(
    'a user who becomes %s loses the session at the next request',
    async (status) => {
      const aff = await seedUser(ctx, { role: 'affiliate' });
      const cookie = await login(ctx, aff.email, aff.password);
      expect((await get('/t/any', cookie)).statusCode).toBe(200);
      await ctx.db.update(users).set({ status }).where(eq(users.id, aff.id));
      for (const url of ['/t/any', '/api/auth/me']) {
        const res = await get(url, cookie);
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ code: 'unauthenticated' });
      }
      expect((await get('/t/public', cookie)).json()).toEqual({ authenticated: false });
    },
  );

  it('removing a permission takes effect at the next request, granting one too', async () => {
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['orders.read'] });
    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
    const cookie = await login(ctx, sm.email, sm.password);
    expect((await get('/t/orders', cookie)).statusCode).toBe(200);
    await ctx.db.delete(userPermissions).where(and(eq(userPermissions.userId, sm.id)));
    const denied = await get('/t/orders', cookie);
    expect(denied.statusCode).toBe(403);
    expect((await get('/api/auth/me', cookie)).json().permissions).toEqual([]);
    await ctx.db.insert(userPermissions).values({ userId: sm.id, permission: 'orders.read' });
    expect((await get('/t/orders', cookie)).statusCode).toBe(200);
  });

  it('losing the owner flag or the Super Manager role takes effect at once', async () => {
    const owner = await seedUser(ctx, { role: 'super_manager', isOwner: true });
    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
    const cookie = await login(ctx, owner.email, owner.password);
    expect((await get('/t/owner', cookie)).statusCode).toBe(200);
    await ctx.db.update(users).set({ isOwner: false }).where(eq(users.id, owner.id));
    expect((await get('/t/owner', cookie)).statusCode).toBe(403);
    expect((await get('/t/orders', cookie)).statusCode).toBe(403);
    await ctx.db.update(users).set({ role: 'affiliate' }).where(eq(users.id, owner.id));
    const me = (await get('/api/auth/me', cookie)).json();
    expect(me).toMatchObject({ role: 'affiliate', isOwner: false, permissions: [] });
  });

  it('a deleted user’s cookie is simply anonymous', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const cookie = await login(ctx, aff.email, aff.password);
    await ctx.db.delete(users).where(eq(users.id, aff.id));
    expect((await get('/t/any', cookie)).statusCode).toBe(401);
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
  });
});

describe('auth plugin: two-factor enrolment', () => {
  async function superManager() {
    const sm = await seedUser(ctx, { role: 'super_manager', permissions: ['orders.read'] });
    return { sm, cookie: await login(ctx, sm.email, sm.password) };
  }

  it('limits a Super Manager without 2FA to health, /me and logout until they enrol', async () => {
    const { cookie } = await superManager();
    expect((await get('/api/health')).statusCode).toBe(200);
    const me = await get('/api/auth/me', cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json().mustEnroll2fa).toBe(true);
    const blocked = await get('/t/orders', cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ code: '2fa_enrollment_required' });
    expect((await get('/t/any', cookie)).json()).toEqual({ code: '2fa_enrollment_required' });
  });

  it('follows the setting and the user’s 2FA state live', async () => {
    const { sm, cookie } = await superManager();
    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
    expect((await get('/t/orders', cookie)).statusCode).toBe(200);
    await ctx.db.update(settings).set({ value: true });
    expect((await get('/t/orders', cookie)).statusCode).toBe(403);
    await ctx.db.update(users).set({ totpEnabled: true }).where(eq(users.id, sm.id));
    expect((await get('/t/orders', cookie)).statusCode).toBe(200);
    expect((await get('/api/auth/me', cookie)).json().twoFactorEnabled).toBe(true);
  });

  it('defaults to required when no setting row exists or the stored value is not a boolean', async () => {
    const { cookie } = await superManager();
    expect((await get('/t/orders', cookie)).statusCode).toBe(403);
    await ctx.db.insert(settings).values({ key: 'security.require_2fa_super_managers', value: 'no' });
    expect((await get('/t/orders', cookie)).statusCode).toBe(403);
  });

  it('never asks a sous-manager or an influenceuse to enrol', async () => {
    const aff = await seedUser(ctx, { role: 'affiliate' });
    const sub = await seedUser(ctx, { role: 'sub_manager' });
    for (const user of [aff, sub]) {
      const cookie = await login(ctx, user.email, user.password);
      expect((await get('/api/auth/me', cookie)).json().mustEnroll2fa).toBe(false);
      expect((await get('/t/any', cookie)).statusCode).toBe(200);
    }
  });

  it('lets a Super Manager still in enrolment log out', async () => {
    const { cookie } = await superManager();
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'x-requested-with': 'fetch', origin: ctx.config.appOrigin, cookie },
    });
    expect(out.statusCode).toBe(204);
    expect((await get('/api/auth/me', cookie)).statusCode).toBe(401);
  });
});

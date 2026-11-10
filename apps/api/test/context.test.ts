import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { userPermissions, users } from '../src/db/schema';
import { connectAsOwner, createTestClock, createTestContext, login, seedUser } from './context';

describe('test harness', () => {
  it('gives each context its own database and drops it on close', async () => {
    const a = await createTestContext();
    const b = await createTestContext();
    try {
      expect(a.databaseName).not.toBe(b.databaseName);
      const seeded = await seedUser(a, { role: 'affiliate' });
      expect(await a.db.select().from(users).where(eq(users.id, seeded.id))).toHaveLength(1);
      expect(await b.db.select().from(users)).toHaveLength(0);
    } finally {
      await a.close();
      await b.close();
    }
    const admin = await connectAsOwner('postgres');
    try {
      const left = await admin.query('select 1 from pg_database where datname = any($1)', [
        [a.databaseName, b.databaseName],
      ]);
      expect(left.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
    await a.close(); // closing twice is harmless
  });

  it('seeds users with permissions and owner flag; login arrives in Task 7', async () => {
    const ctx = await createTestContext();
    try {
      const owner = await seedUser(ctx, { role: 'super_manager', isOwner: true });
      const sub = await seedUser(ctx, {
        role: 'sub_manager',
        permissions: ['orders.read', 'orders.write'],
        status: 'suspended',
      });
      const [row] = await ctx.db.select().from(users).where(eq(users.id, owner.id));
      expect(row?.isOwner).toBe(true);
      expect(row?.status).toBe('active');
      const perms = await ctx.db.select().from(userPermissions).where(eq(userPermissions.userId, sub.id));
      expect(perms.map((p) => p.permission).sort()).toEqual(['orders.read', 'orders.write']);
      await expect(login(ctx, owner.email, owner.password)).rejects.toThrow('login() is available from Task 7');
    } finally {
      await ctx.close();
    }
  });

  it('exposes the app, a memory mailer and a settable clock', async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
      expect(res.json()).toEqual({ ok: true, db: 'up' });
      await ctx.mailer.send({ to: 'a@example.test', subject: 's', text: 't', html: 'h' });
      expect(ctx.mailer.sent).toHaveLength(1);
      const start = ctx.clock.now.getTime();
      ctx.clock.advance(60_000);
      expect(ctx.clock().getTime()).toBe(start + 60_000);
      ctx.clock.now = new Date('2030-01-01T00:00:00.000Z');
      expect(ctx.clock().toISOString()).toBe('2030-01-01T00:00:00.000Z');
      expect(createTestClock(new Date(5)).now.getTime()).toBe(5);
    } finally {
      await ctx.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { connectAsOwner, createTestContext, type TestContext } from '../../test/context';
import { auditLog, users } from './schema';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

// drizzle wraps driver errors; the Postgres error is on `cause`.
async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message: string } }).cause;
    return cause ?? (err as { code?: string; message: string });
  }
  throw new Error('expected the statement to be rejected');
}

describe('users', () => {
  it('rejects two emails that differ only by case (citext unique)', async () => {
    await ctx.db.insert(users).values({ email: 'Aya@Example.com', fullName: 'Aya', role: 'affiliate' });
    const err = await pgError(
      ctx.db.insert(users).values({ email: 'aya@example.COM', fullName: 'Aya 2', role: 'affiliate' }),
    );
    expect(err.code).toBe('23505');
  });

  it('rejects is_owner=true on a non super_manager role', async () => {
    const err = await pgError(
      ctx.db
        .insert(users)
        .values({ email: 'owner@example.com', fullName: 'Owner', role: 'affiliate', isOwner: true }),
    );
    expect(err.code).toBe('23514');
  });

  it('accepts an owner with the super_manager role and applies column defaults', async () => {
    const [row] = await ctx.db
      .insert(users)
      .values({ email: 'boss@example.com', fullName: 'Boss', role: 'super_manager', isOwner: true })
      .returning();
    expect(row?.status).toBe('invited');
    expect(row?.failedLogins).toBe(0);
    expect(row?.totpEnabled).toBe(false);
    expect(row?.passwordHash).toBeNull();
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects an unknown role or status', async () => {
    const badRole = await pgError(
      ctx.db.execute(sql`insert into users (id, email, full_name, role) values (gen_random_uuid(), 'x@example.com', 'X', 'god')`),
    );
    expect(badRole.code).toBe('23514');
    const badStatus = await pgError(
      ctx.db.execute(sql`insert into users (id, email, full_name, role, status) values (gen_random_uuid(), 'y@example.com', 'Y', 'affiliate', 'weird')`),
    );
    expect(badStatus.code).toBe('23514');
  });
});

describe('audit_log (append-only, as darling_app)', () => {
  it('allows INSERT and SELECT', async () => {
    await ctx.db.insert(auditLog).values({ action: 'test.created', entityType: 'test', entityId: '1' });
    const rows = await ctx.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
  });

  it('rejects UPDATE', async () => {
    const err = await pgError(ctx.db.update(auditLog).set({ action: 'tampered' }));
    expect(err.message).toMatch(/permission denied/i);
  });

  it('rejects DELETE', async () => {
    const err = await pgError(ctx.db.delete(auditLog));
    expect(err.message).toMatch(/permission denied/i);
  });

  it('rejects TRUNCATE', async () => {
    const err = await pgError(ctx.db.execute(sql`truncate audit_log`));
    expect(err.message).toMatch(/permission denied/i);
  });

  it('rejects UPDATE and DELETE even for the table owner (trigger)', async () => {
    const owner = await connectAsOwner(ctx.databaseName);
    try {
      const upd = await owner.query(`update audit_log set action = 'x'`).catch((e: Error) => e);
      expect(upd).toBeInstanceOf(Error);
      expect((upd as Error).message).toMatch(/append-only/i);
      const del = await owner.query(`delete from audit_log`).catch((e: Error) => e);
      expect(del).toBeInstanceOf(Error);
      expect((del as Error).message).toMatch(/append-only/i);
    } finally {
      await owner.end();
    }
  });
});

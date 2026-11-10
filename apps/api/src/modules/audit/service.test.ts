import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../../db/schema';
import { createTestContext, seedUser, type TestContext } from '../../../test/context';
import { recordAudit } from './service';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('recordAudit', () => {
  it('writes every field of the entry', async () => {
    const actor = await seedUser(ctx, { role: 'super_manager', isOwner: true });
    await recordAudit(ctx.db, {
      actorUserId: actor.id,
      action: 'user.update',
      entityType: 'user',
      entityId: 'u-1',
      before: { role: 'affiliate' },
      after: { role: 'sub_manager' },
      reason: 'promotion',
      ip: '203.0.113.5',
      requestId: 'req-12345678',
    });
    const [row] = await ctx.db.select().from(auditLog);
    expect(row).toMatchObject({
      actorUserId: actor.id,
      action: 'user.update',
      entityType: 'user',
      entityId: 'u-1',
      before: { role: 'affiliate' },
      after: { role: 'sub_manager' },
      reason: 'promotion',
      ip: '203.0.113.5',
      requestId: 'req-12345678',
    });
    expect(row?.at).toBeInstanceOf(Date);
  });

  it('accepts a system action with no actor and no optional fields', async () => {
    await recordAudit(ctx.db, { actorUserId: null, action: 'system.boot', entityType: 'system', entityId: '1' });
    const [row] = await ctx.db.select().from(auditLog);
    expect(row).toMatchObject({ actorUserId: null, before: null, after: null, reason: null, ip: null, requestId: null });
  });

  it('commits with its transaction and disappears when the transaction rolls back', async () => {
    await ctx.db.transaction(async (tx) => {
      await recordAudit(tx, { actorUserId: null, action: 'a', entityType: 't', entityId: '1' });
    });
    await expect(
      ctx.db.transaction(async (tx) => {
        await recordAudit(tx, { actorUserId: null, action: 'b', entityType: 't', entityId: '2' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.entityType, 't'));
    expect(rows.map((r) => r.action)).toEqual(['a']);
  });
});

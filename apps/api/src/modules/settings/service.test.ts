import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS } from '@darling/shared';
import { settings } from '../../db/schema';
import { createTestContext, type TestContext } from '../../../test/context';
import { getSetting } from './service';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.close();
});

describe('getSetting', () => {
  it('returns the default when no row exists', async () => {
    expect(await getSetting(ctx.db, 'security.require_2fa_super_managers')).toBe(true);
    expect(await getSetting(ctx.db, 'company.name')).toBe(SETTING_DEFAULTS['company.name']);
  });

  it('returns the stored value when it is valid', async () => {
    await ctx.db.insert(settings).values([
      { key: 'security.require_2fa_super_managers', value: false },
      { key: 'company.name', value: '  Maison Darling  ' },
    ]);
    expect(await getSetting(ctx.db, 'security.require_2fa_super_managers')).toBe(false);
    // Parsed through the registry schema, so its trim applies.
    expect(await getSetting(ctx.db, 'company.name')).toBe('Maison Darling');
  });

  it('falls back to the default when the stored value is invalid', async () => {
    await ctx.db.insert(settings).values([
      { key: 'security.require_2fa_super_managers', value: 'false' },
      { key: 'company.name', value: '   ' },
    ]);
    expect(await getSetting(ctx.db, 'security.require_2fa_super_managers')).toBe(true);
    expect(await getSetting(ctx.db, 'company.name')).toBe('DARLING*');
  });

  it('does not confuse a JSON string that looks like another type with that type', async () => {
    await ctx.db.insert(settings).values({ key: 'company.name', value: '2026' });
    expect(await getSetting(ctx.db, 'company.name')).toBe('2026');
    await ctx.db.update(settings).set({ value: 'null' });
    expect(await getSetting(ctx.db, 'company.name')).toBe('null');
  });

  it('works inside a transaction', async () => {
    await ctx.db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: 'security.require_2fa_super_managers', value: false });
      expect(await getSetting(tx, 'security.require_2fa_super_managers')).toBe(false);
    });
  });
});

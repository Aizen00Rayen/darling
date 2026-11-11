import type { OrderStatus } from '@/shared';
import { nextAffiliateCode } from '../affiliates/profiles';
import { createOrder } from '../orders/create';
import { changeStatus } from '../orders/status';
import type { OrderActor } from '../orders/types';
import { seedUser, type TestApp } from './app';
import { orderInput } from './orders';

export interface SeededAffiliate {
  id: string;
  code: string;
  phone: string | null;
  email: string;
  password: string;
}

/** An influenceuse with a profile (code generated the real way). */
export async function seedAffiliate(
  app: TestApp,
  opts: { fullName?: string; phone?: string | null; status?: 'active' | 'invited' | 'suspended' | 'deactivated'; managerId?: string | null; role?: 'affiliate' | 'sub_manager' } = {},
): Promise<SeededAffiliate> {
  const user = await seedUser(app, { role: opts.role ?? 'affiliate', fullName: opts.fullName ?? 'Aya Benali', status: opts.status ?? 'active' });
  const phone = opts.phone === undefined ? null : opts.phone;
  if (phone !== null) app.db.run('UPDATE users SET phone = ? WHERE id = ?', phone, user.id);
  const code = app.db.transaction((tx) => {
    const c = nextAffiliateCode(tx, opts.fullName ?? 'Aya Benali');
    tx.run('INSERT INTO affiliate_profiles (user_id, code, manager_user_id, created_at) VALUES (?, ?, ?, ?)', user.id, c, opts.managerId ?? null, app.clock.now());
    return c;
  }, 'immediate');
  return { id: user.id, code, phone, email: user.email, password: user.password };
}

export const seedManager = (app: TestApp, fullName = 'Karim Chef', status: 'active' | 'suspended' | 'deactivated' | 'invited' = 'active') =>
  seedUser(app, { role: 'sub_manager', fullName, status });

/** `dl_ref=<value>` out of a response's Set-Cookie headers. */
export function refCookieOf(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('dl_ref='))?.split(';')[0];
}
export const setCookieOf = (res: Response): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith('dl_ref='));

export const click = (app: TestApp, code: string, init: { ip?: string; headers?: Record<string, string | null>; landingPath?: string } = {}) =>
  app.call('/api/affiliate/click', { ip: init.ip, headers: init.headers, body: { code, landingPath: init.landingPath ?? '/' } });

let phoneSeq = 0;
/** A distinct valid phone per call (the intake budget is 3 an hour per phone). */
export const freshPhone = (): string => `06${String(10_000_000 + (phoneSeq += 1)).slice(-8)}`;

/** The first click of `code` as a cookie value (`dl_ref=...`). */
export async function cookieFor(app: TestApp, code: string, ip?: string): Promise<string> {
  const res = await click(app, code, { ip });
  const cookie = refCookieOf(res);
  if (!cookie) throw new Error(`no cookie for ${code}: ${res.status}`);
  return cookie;
}

export const placeOrder = (app: TestApp, cookie: string | undefined, over: Partial<ReturnType<typeof orderInput>> = {}) =>
  app.call('/api/orders', { cookie, body: { ...orderInput({ phone: freshPhone(), ...over }) } });

/** Creates an order straight through the domain (no HTTP) with the given click and returns it. */
export function makeOrder(app: TestApp, opts: { clickId?: string; phone?: string; affiliateCode?: string; createdBy?: string; source?: 'website' | 'instagram' } = {}) {
  return createOrder(app, orderInput({ phone: opts.phone ?? freshPhone() }), {
    source: opts.source ?? 'website',
    ...(opts.clickId ? { refClickId: opts.clickId } : {}),
    ...(opts.affiliateCode ? { affiliateCode: opts.affiliateCode } : {}),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
  }).order;
}

export const moveTo = (app: TestApp, actor: OrderActor, orderId: string, ...path: OrderStatus[]) => {
  for (const to of path) changeStatus(app, actor, orderId, to);
};

/** All commission rows of an order, affiliate first. */
export const commissionsOf = (app: TestApp, orderId: string) =>
  app.db.all<{ id: string; kind: string; amount: number; status: string; on_hold: number; hold_reason: string | null; payout_id: string | null; cancel_reason: string | null; beneficiary_user_id: string }>(
    'SELECT id, kind, amount, status, on_hold, hold_reason, payout_id, cancel_reason, beneficiary_user_id FROM commissions WHERE order_id = ? ORDER BY kind',
    orderId,
  );

/** A click row inserted directly (for attribution tests that do not need the endpoint). */
export function insertClick(app: TestApp, affiliateId: string, over: { id?: string; at?: number } = {}): string {
  const id = over.id ?? `018f0000-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  app.db.run("INSERT INTO affiliate_clicks (id, affiliate_user_id, ip_hash, at, landing_path) VALUES (?, ?, 'h', ?, '/')", id, affiliateId, over.at ?? app.clock.now());
  return id;
}

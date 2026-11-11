import { AFFILIATE_CODE_PATTERN, normalizePhone } from '@/shared';
import type { Config } from '../config';
import type { Db } from '../db/sqlite';
import { refCookieValue, verifyRef } from '../affiliates/ref';
import { findActiveAffiliate } from '../affiliates/clicks';
import { getSetting } from '../settings';
import type { Attribution } from './types';

/**
 * The click id carried by the request's `dl_ref` cookie, or null: a missing, malformed, forged or foreign-key cookie
 * is silently ignored (the order is then a normal website order). Signature compared in constant time.
 */
export function clickIdFromRequest(request: Request, config: Pick<Config, 'encryptionKey'>): string | null {
  return verifyRef(config, refCookieValue(request.headers.get('cookie')));
}

interface AffiliateState {
  managerUserId: string | null;
  affiliatePhone: string | null;
  managerPhone: string | null;
}

/** Her CURRENT manager (when active) and the phones that count as self-referral, read in the order's transaction. */
function stateOf(tx: Db, affiliateUserId: string): AffiliateState {
  const row = tx.get<{ manager_user_id: string | null; phone: string | null; m_status: string | null; m_role: string | null; m_phone: string | null }>(
    `SELECT p.manager_user_id, u.phone, m.status AS m_status, m.role AS m_role, m.phone AS m_phone
     FROM affiliate_profiles p JOIN users u ON u.id = p.user_id LEFT JOIN users m ON m.id = p.manager_user_id
     WHERE p.user_id = ?`,
    affiliateUserId,
  );
  const managerActive = row?.manager_user_id != null && row.m_status === 'active' && row.m_role === 'sub_manager';
  return {
    managerUserId: managerActive ? (row?.manager_user_id ?? null) : null,
    affiliatePhone: row?.phone ?? null,
    managerPhone: managerActive ? (row?.m_phone ?? null) : null,
  };
}

const samePhone = (customer: string, other: string | null): boolean => other !== null && (normalizePhone(other) ?? other) === customer;

function build(tx: Db, affiliateUserId: string, phone: string, clickId: string | null): Attribution {
  const state = stateOf(tx, affiliateUserId);
  return {
    affiliateUserId,
    managerUserId: state.managerUserId,
    clickId,
    // The customer is the influenceuse herself (or her manager): the commissions are held until an admin looks.
    selfReferral: samePhone(phone, state.affiliatePhone) || samePhone(phone, state.managerPhone),
  };
}

/**
 * The attribution of an order placed with a (verified) click id, decided INSIDE the order's transaction: the click
 * must exist, be younger than `attribution.window_days`, and belong to an influenceuse who is active and still has the
 * role. Anything else gives null (a normal website order). At most one influenceuse per order by construction.
 */
export function resolveAttribution(tx: Db, input: { clickId: string; phone: string; now: number }): Attribution | null {
  const click = tx.get<{ affiliate_user_id: string; at: number }>('SELECT affiliate_user_id, at FROM affiliate_clicks WHERE id = ?', input.clickId);
  if (!click) return null;
  const windowMs = getSetting(tx, 'attribution.window_days') * 86_400_000;
  if (input.now - click.at > windowMs || click.at > input.now + 60_000) return null;
  const active = tx.get("SELECT 1 AS ok FROM users WHERE id = ? AND status = 'active' AND role = 'affiliate'", click.affiliate_user_id);
  if (!active || !tx.get('SELECT 1 AS ok FROM affiliate_profiles WHERE user_id = ?', click.affiliate_user_id)) return null;
  return build(tx, click.affiliate_user_id, input.phone, input.clickId);
}

/** Staff attribution by code (no cookie, no click): null when the code is unknown or its owner is not active. */
export function attributeByCode(tx: Db, code: string, phone: string): (Attribution & { code: string }) | null {
  if (!AFFILIATE_CODE_PATTERN.test(code)) return null;
  const found = findActiveAffiliate(tx, code);
  return found ? { ...build(tx, found.userId, phone, null), code } : null;
}

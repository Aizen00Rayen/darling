import { AFFILIATE_CODE_PATTERN } from '@/shared';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/sqlite';
import { newId } from '../ids';
import { getSetting } from '../settings';
import { hashIp } from './ref';
import { UNKNOWN_IP } from '../net/client-ip';

/** Repeat clicks of the same visitor (same ip hash) on the same affiliate inside this window count once. */
export const CLICK_DEDUPE_MS = 30 * 60_000;

/** Crawlers and link-preview fetchers: they do not run our script, but one that does must not count as a visitor. */
const BOT_AGENT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|curl|wget|python-requests|httpclient/i;
export const isBotAgent = (userAgent: string | null): boolean => userAgent !== null && BOT_AGENT.test(userAgent);

/** The host of a Referer URL (lower-case, at most 100 characters), or null. Never the path or the query. */
export function referrerHost(referer: string | null): string | null {
  if (!referer || referer.length > 2000) return null;
  try {
    const host = new URL(referer).hostname.toLowerCase();
    return host === '' ? null : host.slice(0, 100);
  } catch {
    return null;
  }
}

/** The path of a landing page, never the query string: `/`, `/produit/x`. Anything odd becomes `/`. */
export function cleanLandingPath(path: unknown): string {
  if (typeof path !== 'string') return '/';
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  if (!bare.startsWith('/') || bare.startsWith('//') || bare.length > 200 || /[\u0000-\u001f\u007f\\]/.test(bare)) return '/';
  return bare;
}

export interface ClickDeps {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'encryptionKey'>;
}

/** The active influenceuse behind a code: her user must be active AND still have the affiliate role. */
export function findActiveAffiliate(db: Db, code: string): { userId: string } | null {
  if (!AFFILIATE_CODE_PATTERN.test(code)) return null;
  const row = db.get<{ user_id: string }>(
    `SELECT p.user_id FROM affiliate_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.code = ? AND u.status = 'active' AND u.role = 'affiliate'`,
    code,
  );
  return row ? { userId: row.user_id } : null;
}

/**
 * Records a click for a code (one immediate transaction): null for an unknown or inactive influenceuse (nothing is
 * stored), otherwise the id of the click row, which is the EXISTING row when the same visitor (ip hash) clicked the
 * same influenceuse less than 30 minutes ago. An unidentifiable client address ('unknown') is never merged: distinct
 * visitors behind one unreadable proxy must not share a click.
 */
export function recordClick(
  deps: ClickDeps,
  input: { code: string; ip: string; referer: string | null; landingPath: unknown },
): { clickId: string; created: boolean } | null {
  return deps.db.transaction((tx) => {
    const affiliate = findActiveAffiliate(tx, input.code);
    if (!affiliate) return null;
    const now = deps.clock.now();
    const ipHash = hashIp(deps.config, input.ip);
    if (input.ip !== UNKNOWN_IP) {
      const recent = tx.get<{ id: string }>(
        'SELECT id FROM affiliate_clicks WHERE affiliate_user_id = ? AND ip_hash = ? AND at > ? ORDER BY at DESC LIMIT 1',
        affiliate.userId,
        ipHash,
        now - CLICK_DEDUPE_MS,
      );
      if (recent) return { clickId: recent.id, created: false };
    }
    const id = newId(deps.clock);
    tx.run(
      'INSERT INTO affiliate_clicks (id, affiliate_user_id, ip_hash, at, referrer_host, landing_path) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      affiliate.userId,
      ipHash,
      now,
      referrerHost(input.referer),
      cleanLandingPath(input.landingPath),
    );
    return { clickId: id, created: true };
  }, 'immediate');
}

/** The attribution window in days, from the settings. */
export const windowDays = (db: Db): number => getSetting(db, 'attribution.window_days');

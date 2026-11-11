import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config';

// Keys for the affiliate click machinery, derived from ENCRYPTION_KEY with HKDF (one purpose per key, so the cookie
// signature key can never be used to unmask an ip hash and vice versa). Derived once per key and cached.

const cache = new WeakMap<Buffer, Map<string, Buffer>>();

function derive(masterKey: Buffer, info: string): Buffer {
  let perKey = cache.get(masterKey);
  if (!perKey) {
    perKey = new Map();
    cache.set(masterKey, perKey);
  }
  let key = perKey.get(info);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
    perKey.set(info, key);
  }
  return key;
}

/** HMAC-SHA256 of the client address under the 'dl-ip' key: stable for counting visitors, useless for recovering an address. */
export function hashIp(config: Pick<Config, 'encryptionKey'>, ip: string): string {
  return createHmac('sha256', derive(config.encryptionKey, 'dl-ip')).update(ip).digest('hex');
}

export const REF_COOKIE = 'dl_ref';

const MAC = /^[A-Za-z0-9_-]{43}$/;
const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(config: Pick<Config, 'encryptionKey'>, clickId: string): string {
  return createHmac('sha256', derive(config.encryptionKey, 'dl-ref')).update(clickId).digest('base64url');
}

/** The cookie value: `<clickId>.<hmac>`. */
export function signRef(config: Pick<Config, 'encryptionKey'>, clickId: string): string {
  return `${clickId}.${mac(config, clickId)}`;
}

/** The click id of a genuine cookie value, or null for anything else (checked in constant time). */
export function verifyRef(config: Pick<Config, 'encryptionKey'>, value: string | undefined | null): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const dot = value.indexOf('.');
  if (dot === -1) return null;
  const clickId = value.slice(0, dot);
  const given = value.slice(dot + 1);
  if (!CLICK_ID.test(clickId) || !MAC.test(given)) return null;
  const expected = Buffer.from(mac(config, clickId));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? clickId : null;
}

/** The `dl_ref` value out of a Cookie header (the first one; a duplicate name is ignored, never merged). */
export function refCookieValue(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REF_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Set-Cookie for the attribution cookie: HttpOnly, SameSite=Lax, Path=/, Secure per config, Max-Age = the window. */
export function refSetCookie(config: Pick<Config, 'encryptionKey' | 'cookieSecure'>, clickId: string, windowDays: number): string {
  const parts = [`${REF_COOKIE}=${signRef(config, clickId)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.round(windowDays * 86_400)}`];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

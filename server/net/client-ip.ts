import { isIP } from 'node:net';
import { log, type Logger } from '../log';

// Real client address behind Hostinger's reverse proxy (spec section 3).
//
// `trustedProxyHops` is the number of trusted proxies between the internet and this app. Each one appends
// the address it received the connection from to X-Forwarded-For, so the client address is the entry
// `hops` positions from the RIGHT. Entries to its left are supplied by the client and are never used.
// hops = 0 means "no trusted proxy": the header is ignored and the socket address is used.

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export const UNKNOWN_IP = 'unknown';

/** Returns a normalised IP (lower-case IPv6, IPv4-mapped IPv6 as IPv4) or null when `raw` is not an IP address. */
function normalise(raw: string, allowZone: boolean): string | null {
  let value = raw.trim();
  if (!value || value.length > 64) return null;

  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value);
  if (bracketed) {
    if (bracketed[2] !== undefined && Number(bracketed[2]) > 65535) return null;
    value = bracketed[1]!;
  } else {
    const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value);
    if (v4port) {
      if (Number(v4port[2]) > 65535) return null;
      value = v4port[1]!;
    }
  }

  if (value.includes('%')) {
    if (!allowZone) return null;
    value = value.slice(0, value.indexOf('%'));
  }

  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) {
    const lower = value.toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
    return lower;
  }
  return null;
}

function headerValue(headers: HeaderBag, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value.join(',') : (value ?? '');
  }
  return '';
}

export function clientIp(headers: HeaderBag, socketAddress: string | undefined, hops: number): string {
  if (!Number.isInteger(hops) || hops < 0) throw new RangeError('hops must be a non-negative integer');
  const socket = socketAddress ? normalise(socketAddress, true) : null;
  if (hops === 0) return socket ?? UNKNOWN_IP;

  const entries = headerValue(headers, 'x-forwarded-for')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  // Exactly the entry `hops` from the right; a malformed one is not skipped in favour of a value further left.
  if (entries.length >= hops) {
    const picked = normalise(entries[entries.length - hops]!, false);
    if (picked) return picked;
  }

  // Next.js only fills X-Forwarded-For when it is MISSING (it never appends), and some proxies set only X-Real-IP.
  // A single, valid address from that header is the next best evidence; then the socket; then "unknown".
  const real = headerValue(headers, 'x-real-ip').trim();
  if (real !== '' && !real.includes(',')) {
    const picked = normalise(real, false);
    if (picked) return picked;
  }
  return socket ?? UNKNOWN_IP;
}

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

/** True for "unknown", loopback, private, link-local, CGNAT and unspecified addresses: not a real client on the internet. */
export function isUnidentifiable(ip: string): boolean {
  if (ip === UNKNOWN_IP) return true;
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4 as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::' || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
}

let warned = false;
/** Tests only. */
export function resetClientIpWarning(): void {
  warned = false;
}

/**
 * In production, logs ONE warning per process the first time the derived client address is not a real client
 * address (see isUnidentifiable). That means the proxy does not pass X-Forwarded-For / X-Real-IP, or
 * TRUSTED_PROXY_HOPS is wrong, and every visitor shares one rate-limit bucket. Never logs an address.
 */
export function noteClientIp(ip: string, config: { isProduction: boolean }, logger: Pick<Logger, 'warn'> = log): void {
  if (warned || !config.isProduction || !isUnidentifiable(ip)) return;
  warned = true;
  logger.warn('client_ip.unidentifiable', {
    hint:
      'The client address derived for a request is unknown, loopback or private. Check that the reverse proxy sends X-Forwarded-For ' +
      '(or X-Real-IP) with the visitor address and that TRUSTED_PROXY_HOPS matches the number of proxies in front of the app; ' +
      'until then all visitors share one rate-limit bucket.',
  });
}

import { isIP } from 'node:net';

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
  const fallback = socket ?? UNKNOWN_IP;
  if (hops === 0) return fallback;

  const entries = headerValue(headers, 'x-forwarded-for')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length < hops) return fallback;

  // Exactly the entry `hops` from the right; a malformed one is not skipped in favour of a value further left.
  return normalise(entries[entries.length - hops]!, false) ?? fallback;
}

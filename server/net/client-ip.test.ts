import { beforeEach, describe, expect, it } from 'vitest';
import { clientIp, isUnidentifiable, noteClientIp, resetClientIpWarning } from './client-ip';

const h = (xff?: string | string[]) => (xff === undefined ? {} : { 'x-forwarded-for': xff });

describe('clientIp', () => {
  it('hops=1 takes the last X-Forwarded-For entry (the one the trusted proxy appended)', () => {
    expect(clientIp(h('203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp(h('203.0.113.9, 10.0.0.5'), '10.0.0.1', 1)).toBe('10.0.0.5');
  });

  it('ignores a spoofed left-most value', () => {
    expect(clientIp(h('6.6.6.6, 203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp(h('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('hops=2 takes the second entry from the right', () => {
    expect(clientIp(h('6.6.6.6, 203.0.113.9, 172.16.0.2'), '10.0.0.1', 2)).toBe('203.0.113.9');
  });

  it('falls back to the socket address when there are fewer entries than hops', () => {
    expect(clientIp(h('203.0.113.9'), '10.0.0.1', 2)).toBe('10.0.0.1');
  });

  it('hops=0 ignores the header entirely', () => {
    expect(clientIp(h('6.6.6.6'), '198.51.100.4', 0)).toBe('198.51.100.4');
  });

  it('uses the socket address when the header is absent or empty', () => {
    expect(clientIp({}, '198.51.100.4', 1)).toBe('198.51.100.4');
    expect(clientIp(h(''), '198.51.100.4', 1)).toBe('198.51.100.4');
    expect(clientIp(h(' , '), '198.51.100.4', 1)).toBe('198.51.100.4');
  });

  it('rejects non-IP text in the selected entry (falls back to the socket address)', () => {
    for (const bad of ['unknown', 'evil.example.com', '999.1.1.1', '1.2.3', "1.1.1.1'; DROP TABLE", '<script>', '1.2.3.4.5', '::g', '1.1.1.1 2.2.2.2']) {
      expect(clientIp(h(`6.6.6.6, ${bad}`), '10.0.0.1', 1)).toBe('10.0.0.1');
    }
  });

  it('does not skip over a malformed entry to a valid one further left', () => {
    expect(clientIp(h('203.0.113.9, garbage'), '10.0.0.1', 1)).toBe('10.0.0.1');
  });

  it('handles IPv6, normalised to lower case', () => {
    expect(clientIp(h('2001:DB8::1'), '10.0.0.1', 1)).toBe('2001:db8::1');
    expect(clientIp(h('6.6.6.6, 2001:db8:0:0:0:0:0:2'), '10.0.0.1', 1)).toBe('2001:db8:0:0:0:0:0:2');
    expect(clientIp(h('[2001:db8::3]'), '10.0.0.1', 1)).toBe('2001:db8::3');
  });

  it('strips ports and maps IPv4-in-IPv6 to IPv4', () => {
    expect(clientIp(h('203.0.113.9:51234'), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp(h('[2001:db8::3]:443'), '10.0.0.1', 1)).toBe('2001:db8::3');
    expect(clientIp(h('::ffff:203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp({}, '::ffff:198.51.100.4', 1)).toBe('198.51.100.4');
  });

  it('rejects IPv6 zone identifiers and out-of-range ports in headers', () => {
    expect(clientIp(h('fe80::1%eth0'), '10.0.0.1', 1)).toBe('10.0.0.1');
    expect(clientIp(h('203.0.113.9:99999'), '10.0.0.1', 1)).toBe('10.0.0.1');
  });

  it('joins repeated header lines (array form) in order', () => {
    expect(clientIp(h(['6.6.6.6', '203.0.113.9']), '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('works with a Headers object and any header-name casing', () => {
    expect(clientIp(new Headers({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' }), '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientIp({ 'X-FORWARDED-FOR': '203.0.113.9' }, '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('returns "unknown" when nothing valid is available', () => {
    expect(clientIp({}, undefined, 1)).toBe('unknown');
    expect(clientIp(h('nope'), 'also-not-an-ip', 1)).toBe('unknown');
    expect(clientIp({}, '', 0)).toBe('unknown');
  });

  it('rejects an invalid hops value', () => {
    expect(() => clientIp({}, '1.1.1.1', -1)).toThrow();
    expect(() => clientIp({}, '1.1.1.1', 1.5)).toThrow();
  });
});

describe('clientIp: X-Real-IP fallback (hops >= 1)', () => {
  const both = (xff: string | undefined, real: string | undefined) => ({
    ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
    ...(real === undefined ? {} : { 'x-real-ip': real }),
  });

  it('uses X-Real-IP when X-Forwarded-For is absent or empty', () => {
    expect(clientIp(both(undefined, '203.0.113.7'), undefined, 1)).toBe('203.0.113.7');
    expect(clientIp(both('', '203.0.113.7'), undefined, 1)).toBe('203.0.113.7');
  });

  it('uses X-Real-IP when X-Forwarded-For has fewer entries than hops or an invalid selected entry', () => {
    expect(clientIp(both('198.51.100.1', '203.0.113.7'), undefined, 2)).toBe('203.0.113.7');
    expect(clientIp(both('nope', '203.0.113.7'), undefined, 1)).toBe('203.0.113.7');
  });

  it('prefers a valid X-Forwarded-For entry over X-Real-IP', () => {
    expect(clientIp(both('198.51.100.1', '203.0.113.7'), undefined, 1)).toBe('198.51.100.1');
  });

  it('accepts only a valid IP in X-Real-IP (ports stripped, junk and lists refused) and then gives "unknown"', () => {
    expect(clientIp(both(undefined, '203.0.113.7:4711'), undefined, 1)).toBe('203.0.113.7');
    expect(clientIp(both(undefined, 'not-an-ip'), undefined, 1)).toBe('unknown');
    expect(clientIp(both(undefined, '1.1.1.1, 2.2.2.2'), undefined, 1)).toBe('unknown');
    expect(clientIp(both(undefined, undefined), undefined, 1)).toBe('unknown');
    expect(clientIp(both(undefined, '2001:DB8::1'), undefined, 1)).toBe('2001:db8::1');
  });

  it('hops=0 ignores both headers', () => {
    expect(clientIp(both('198.51.100.1', '203.0.113.7'), '192.0.2.1', 0)).toBe('192.0.2.1');
  });

  it('keeps the spoof rule: a forged left-most entry never wins over the right-most', () => {
    expect(clientIp(both('6.6.6.6, 198.51.100.1', undefined), undefined, 1)).toBe('198.51.100.1');
  });
});

describe('isUnidentifiable', () => {
  it.each(['unknown', '127.0.0.1', '127.5.5.5', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', 'fc00::1', 'fd12::1', 'fe80::1'])(
    '%s is not a client address',
    (ip) => expect(isUnidentifiable(ip)).toBe(true),
  );
  it.each(['203.0.113.7', '172.32.0.1', '172.15.0.1', '8.8.8.8', '2001:db8::1', '2a00:1450::1'])('%s is', (ip) => expect(isUnidentifiable(ip)).toBe(false));
});

describe('noteClientIp (one production warning per process)', () => {
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const logger = { info() {}, error() {}, warn: (event: string, fields: Record<string, unknown> = {}) => void lines.push({ event, fields }) };
  beforeEach(() => {
    lines.length = 0;
    resetClientIpWarning();
  });

  it('warns once, in production, the first time the address is unknown, loopback or private', () => {
    noteClientIp('203.0.113.7', { isProduction: true }, logger);
    expect(lines).toHaveLength(0);
    noteClientIp('unknown', { isProduction: true }, logger);
    noteClientIp('10.0.0.2', { isProduction: true }, logger);
    noteClientIp('127.0.0.1', { isProduction: true }, logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('client_ip.unidentifiable');
    const text = JSON.stringify(lines[0]);
    expect(text).toMatch(/X-Forwarded-For/);
    expect(text).toMatch(/X-Real-IP/);
    expect(text).toMatch(/TRUSTED_PROXY_HOPS/);
    expect(text).not.toContain('10.0.0.2'); // never an address
  });

  it('is silent outside production', () => {
    noteClientIp('unknown', { isProduction: false }, logger);
    expect(lines).toHaveLength(0);
  });
});

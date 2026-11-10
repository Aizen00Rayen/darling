import { describe, expect, it } from 'vitest';
import { clientIp } from './client-ip';

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

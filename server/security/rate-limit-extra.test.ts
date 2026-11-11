import { describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { createRateLimiter, LIMITS, rateLimitKey, rateLimited } from './rate-limit';

const opts = { max: 3, windowMs: 60_000 };

describe('rateLimitKey', () => {
  it('keeps IPv4 addresses and other keys as they are', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('unknown')).toBe('unknown');
    expect(rateLimitKey('user:abc')).toBe('user:abc');
  });

  it('groups IPv6 addresses by their /64 prefix, whatever the spelling', () => {
    const a = rateLimitKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(rateLimitKey('2001:DB8:1:2::1')).toBe(a);
    expect(rateLimitKey('2001:0db8:0001:0002:0000:0000:0000:0042')).toBe(a);
    expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(a);
    expect(rateLimitKey('2001:db8:1:2::1')).not.toBe('2001:db8:1:2::1'); // not the bare address
    expect(rateLimitKey('::1')).toBe(rateLimitKey('0:0:0:0:0:0:0:5'));
  });

  it('maps IPv4-mapped IPv6 to the IPv4 address', () => {
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });
});

describe('rateLimited', () => {
  const ctx = () => ({ limiter: createRateLimiter(fixedClock()) });
  const budget = { bucket: 'b', max: 2, windowMs: 60_000, scaleUnknown: true } as const;

  it('shares one /64 bucket across the addresses of a prefix', () => {
    const c = ctx();
    expect(rateLimited(c, budget, '2001:db8::1')).toBeNull();
    expect(rateLimited(c, budget, '2001:db8::2')).toBeNull();
    expect(rateLimited(c, budget, '2001:db8::3')?.status).toBe(429);
    expect(rateLimited(c, budget, '2001:db9::1')).toBeNull();
  });

  it('gives the shared "unknown" bucket four times the budget, but only for budgets that opt in', () => {
    const c = ctx();
    const results = Array.from({ length: 9 }, () => rateLimited(c, budget, 'unknown')?.status ?? 0);
    expect(results).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 429]);
    const c2 = ctx();
    const plain = { bucket: 'p', max: 2, windowMs: 60_000 };
    expect([0, 1, 2].map(() => rateLimited(c2, plain, 'unknown')?.status ?? 0)).toEqual([0, 0, 429]);
  });

  it('login, token and forgot budgets opt in; the per-user budget is keyed by user, not address', () => {
    expect(LIMITS.login.scaleUnknown).toBe(true);
    expect(LIMITS.token.scaleUnknown).toBe(true);
    expect(LIMITS.forgot.scaleUnknown).toBe(true);
    expect('scaleUnknown' in LIMITS.passwordVerify).toBe(false);
  });
});

describe('capacity and sweeping', () => {
  it('evicts the oldest entry in O(1) when full, keeping the newest', () => {
    const rl = createRateLimiter(fixedClock(), { maxEntries: 3 });
    for (const k of ['a', 'b', 'c']) rl.limit('x', k, opts);
    for (let i = 0; i < 3; i += 1) rl.limit('x', 'a', opts); // 'a' is over its budget now
    rl.limit('x', 'd', opts); // full: evicts the oldest ('a')
    expect(rl.size()).toBe(3);
    expect(rl.limit('x', 'a', opts).ok).toBe(true); // forgotten: a fresh window
    expect(rl.size()).toBe(3);
  });

  it('sweeps expired entries at most once a minute, lazily', () => {
    const clock = fixedClock();
    const rl = createRateLimiter(clock);
    for (let i = 0; i < 10; i += 1) rl.limit('x', `k${i}`, { max: 1, windowMs: 1_000 });
    clock.advance(30_000); // all expired, but no sweep is due yet
    rl.limit('x', 'new1', opts);
    expect(rl.size()).toBe(11);
    clock.advance(30_000); // 60 s since the start: the next call sweeps
    rl.limit('x', 'new2', opts);
    expect(rl.size()).toBeLessThanOrEqual(3); // new1 (still live) and new2; the ten expired ones are gone
  });

  it('stays fast with a full table: 1000 calls against 50k entries', () => {
    const rl = createRateLimiter(fixedClock(), { maxEntries: 50_000 });
    for (let i = 0; i < 50_000; i += 1) rl.limit('x', `k${i}`, opts);
    expect(rl.size()).toBe(50_000);
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) rl.limit('x', `n${i}`, opts);
    expect(performance.now() - start).toBeLessThan(150);
    expect(rl.size()).toBe(50_000);
  });
});

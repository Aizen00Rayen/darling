import { describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { createRateLimiter, tooManyAttemptsResponse } from './rate-limit';

const opts = { max: 3, windowMs: 60_000 };

describe('createRateLimiter', () => {
  it('lets max requests through per key and window, then refuses with a Retry-After', () => {
    const clock = fixedClock();
    const rl = createRateLimiter(clock);
    expect(rl.limit('login', 'ip1', opts)).toEqual({ ok: true, retryAfterSeconds: 0 });
    expect(rl.limit('login', 'ip1', opts).ok).toBe(true);
    expect(rl.limit('login', 'ip1', opts).ok).toBe(true);
    clock.advance(10_500);
    const refused = rl.limit('login', 'ip1', opts);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSeconds).toBe(50); // 49.5 s left, rounded up
  });

  it('keys are independent', () => {
    const rl = createRateLimiter(fixedClock());
    for (let i = 0; i < 3; i += 1) rl.limit('login', 'a', opts);
    expect(rl.limit('login', 'a', opts).ok).toBe(false);
    expect(rl.limit('login', 'b', opts).ok).toBe(true);
  });

  it('named buckets are shared by every caller using the name and separate from other names', () => {
    const rl = createRateLimiter(fixedClock());
    rl.limit('verify', 'user:1', opts);
    rl.limit('verify', 'user:1', opts);
    rl.limit('verify', 'user:1', opts);
    expect(rl.limit('verify', 'user:1', opts).ok).toBe(false);
    expect(rl.limit('other', 'user:1', opts).ok).toBe(true);
  });

  it('starts a new window once the old one has expired (boundary included)', () => {
    const clock = fixedClock();
    const rl = createRateLimiter(clock);
    for (let i = 0; i < 4; i += 1) rl.limit('b', 'k', opts);
    clock.advance(59_999);
    expect(rl.limit('b', 'k', opts).ok).toBe(false);
    clock.advance(1);
    expect(rl.limit('b', 'k', opts).ok).toBe(true);
    expect(rl.limit('b', 'k', opts).ok).toBe(true);
    expect(rl.limit('b', 'k', opts).ok).toBe(true);
    expect(rl.limit('b', 'k', opts).ok).toBe(false);
  });

  it('never reports a Retry-After below one second', () => {
    const clock = fixedClock();
    const rl = createRateLimiter(clock);
    for (let i = 0; i < 3; i += 1) rl.limit('b', 'k', opts);
    clock.advance(59_999);
    expect(rl.limit('b', 'k', opts).retryAfterSeconds).toBe(1);
  });

  it('prunes expired entries so memory stays bounded', () => {
    const clock = fixedClock();
    const rl = createRateLimiter(clock, { maxEntries: 50 });
    for (let i = 0; i < 40; i += 1) rl.limit('b', `k${i}`, opts);
    expect(rl.size()).toBe(40);
    clock.advance(60_000);
    for (let i = 0; i < 40; i += 1) rl.limit('b', `n${i}`, opts);
    expect(rl.size()).toBeLessThanOrEqual(50);
  });

  it('caps the number of live entries even when every key is live (oldest evicted first)', () => {
    const rl = createRateLimiter(fixedClock(), { maxEntries: 100 });
    for (let i = 0; i < 1000; i += 1) rl.limit('b', `k${i}`, opts);
    expect(rl.size()).toBeLessThanOrEqual(100);
  });

  it('reset() forgets everything', () => {
    const rl = createRateLimiter(fixedClock());
    for (let i = 0; i < 4; i += 1) rl.limit('b', 'k', opts);
    rl.reset();
    expect(rl.limit('b', 'k', opts).ok).toBe(true);
  });
});

describe('tooManyAttemptsResponse', () => {
  it('is a 429 too_many_attempts with Retry-After and no-store', async () => {
    const res = tooManyAttemptsResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ code: 'too_many_attempts' });
  });
});

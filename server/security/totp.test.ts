import * as OTPAuth from 'otpauth';
import { describe, expect, it } from 'vitest';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC 6238 SHA-1 test secret "12345678901234567890"
const STEP_MS = 30_000;

function codeAt(step: number, secret = SECRET): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate({ timestamp: step * STEP_MS });
}

const S = 50_000_000;
const now = S * STEP_MS + 12_345; // somewhere inside step S (epoch ms)

describe('verifyTotp', () => {
  it('matches the RFC 6238 vectors (6-digit truncation) and returns the step', () => {
    expect(verifyTotp(SECRET, '287082', 59_000, null)).toBe(1);
    expect(verifyTotp(SECRET, '081804', 1_111_111_109_000, null)).toBe(37_037_036);
  });

  it('accepts the code for steps S-1, S and S+1 and returns that step', () => {
    expect(verifyTotp(SECRET, codeAt(S - 1), now, null)).toBe(S - 1);
    expect(verifyTotp(SECRET, codeAt(S), now, null)).toBe(S);
    expect(verifyTotp(SECRET, codeAt(S + 1), now, null)).toBe(S + 1);
  });

  it('rejects the code for steps S-2 and S+2', () => {
    expect(verifyTotp(SECRET, codeAt(S - 2), now, null)).toBeNull();
    expect(verifyTotp(SECRET, codeAt(S + 2), now, null)).toBeNull();
  });

  it('rejects replay: a matched step <= lastStep returns null', () => {
    expect(verifyTotp(SECRET, codeAt(S), now, S)).toBeNull();
    expect(verifyTotp(SECRET, codeAt(S), now, S + 1)).toBeNull();
    expect(verifyTotp(SECRET, codeAt(S - 1), now, S)).toBeNull();
    expect(verifyTotp(SECRET, codeAt(S), now, S - 1)).toBe(S);
    expect(verifyTotp(SECRET, codeAt(S + 1), now, S)).toBe(S + 1);
  });

  it('accepts a first-ever code (lastStep null) including step 0 territory', () => {
    expect(verifyTotp(SECRET, codeAt(0), 1000, null)).toBe(0);
    expect(verifyTotp(SECRET, codeAt(0), 1000, -1)).toBe(0);
  });

  it('accepts exactly six ASCII digits and nothing else (no whitespace, no look-alikes)', () => {
    const good = codeAt(S);
    expect(verifyTotp(SECRET, good, now, null)).toBe(S);
    for (const bad of [
      ` ${good}`, `${good} `, `${good}\n`, `${good.slice(0, 3)} ${good.slice(3)}`, `${good.slice(0, 3)}-${good.slice(3)}`,
      good.slice(0, 5), `${good}0`, `0${good}`, '', 'abcdef', '１２３４５６', '٠١٢٣٤٥', `${good}\n123456`, '12345e', '+12345', '1e5555',
    ]) {
      expect(verifyTotp(SECRET, bad, now, null), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects a wrong code and a code for another secret', () => {
    expect(verifyTotp(SECRET, codeAt(S, newTotpSecret()), now, null)).toBeNull();
    const good = codeAt(S);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    if (wrong !== codeAt(S - 1) && wrong !== codeAt(S + 1)) expect(verifyTotp(SECRET, wrong, now, null)).toBeNull();
  });

  it('returns null (never throws) for an unreadable secret', () => {
    expect(verifyTotp('not base32 !!!', '123456', now, null)).toBeNull();
    expect(verifyTotp('', '123456', now, null)).toBeNull();
  });
});

describe('newTotpSecret / totpUri', () => {
  it('newTotpSecret is 20 random bytes in base32 (32 characters) and is unique', () => {
    const a = newTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(OTPAuth.Secret.fromBase32(a).bytes).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(a);
  });

  it('a fresh secret works end to end', () => {
    const secret = newTotpSecret();
    expect(verifyTotp(secret, codeAt(S, secret), now, null)).toBe(S);
  });

  it('totpUri is an otpauth URI with issuer DARLING*, SHA1, 6 digits, 30 s', () => {
    const parsed = OTPAuth.URI.parse(totpUri(SECRET, 'ines@example.test')) as OTPAuth.TOTP;
    expect(parsed.issuer).toBe('DARLING*');
    expect(parsed.label).toBe('ines@example.test');
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
    expect(parsed.secret.base32).toBe(SECRET);
  });
});

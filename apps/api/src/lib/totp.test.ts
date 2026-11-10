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
const now = new Date(S * STEP_MS + 12_345); // somewhere inside step S

describe('verifyTotp', () => {
  it('matches the RFC 6238 vectors (6-digit truncation) and returns the step', () => {
    expect(verifyTotp(SECRET, '287082', new Date(59_000), null)).toBe(1);
    expect(verifyTotp(SECRET, '081804', new Date(1_111_111_109_000), null)).toBe(37_037_036);
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
    expect(verifyTotp(SECRET, codeAt(0), new Date(1000), null)).toBe(0);
    expect(verifyTotp(SECRET, codeAt(0), new Date(1000), -1)).toBe(0);
  });

  it('allows only surrounding whitespace and exactly 6 digits', () => {
    const good = codeAt(S);
    expect(verifyTotp(SECRET, ` ${good}\n`, now, null)).toBe(S);
    expect(verifyTotp(SECRET, `${good.slice(0, 3)} ${good.slice(3)}`, now, null)).toBeNull();
    expect(verifyTotp(SECRET, `${good.slice(0, 3)}-${good.slice(3)}`, now, null)).toBeNull();
    expect(verifyTotp(SECRET, good.slice(0, 5), now, null)).toBeNull();
    expect(verifyTotp(SECRET, `${good}0`, now, null)).toBeNull();
    expect(verifyTotp(SECRET, `0${good}`, now, null)).toBeNull();
    expect(verifyTotp(SECRET, '', now, null)).toBeNull();
    expect(verifyTotp(SECRET, 'abcdef', now, null)).toBeNull();
    expect(verifyTotp(SECRET, '１２３４５６', now, null)).toBeNull(); // full-width digits
    expect(verifyTotp(SECRET, `${good}\n123456`, now, null)).toBeNull();
  });

  it('rejects a wrong code and a code for another secret', () => {
    const other = newTotpSecret();
    expect(verifyTotp(SECRET, codeAt(S, other), now, null)).toBeNull();
    const good = codeAt(S);
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    // `wrong` could in theory equal the S-1 or S+1 code; skip the vanishingly rare collision.
    if (wrong !== codeAt(S - 1) && wrong !== codeAt(S + 1)) {
      expect(verifyTotp(SECRET, wrong, now, null)).toBeNull();
    }
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
    const uri = totpUri(SECRET, 'ines@example.test');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    const parsed = OTPAuth.URI.parse(uri) as OTPAuth.TOTP;
    expect(parsed.issuer).toBe('DARLING*');
    expect(parsed.label).toBe('ines@example.test');
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
    expect(parsed.secret.base32).toBe(SECRET);
  });
});

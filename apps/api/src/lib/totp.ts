import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';

const ISSUER = 'DARLING*';
const PERIOD_SECONDS = 30;
const PERIOD_MS = PERIOD_SECONDS * 1000;
const DIGITS = 6;
/** Accept the previous, current and next step to tolerate clock drift. */
const WINDOW = 1;
const SECRET_BYTES = 20;

function totpFor(secret: OTPAuth.Secret, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret,
  });
}

/** 20 random bytes, base32 (the format authenticator apps expect). */
export function newTotpSecret(): string {
  const bytes = new Uint8Array(randomBytes(SECRET_BYTES));
  return new OTPAuth.Secret({ buffer: bytes.buffer }).base32;
}

/** The `otpauth://` URI to render as a QR code during enrolment. */
export function totpUri(secret: string, email: string): string {
  return totpFor(OTPAuth.Secret.fromBase32(secret), email).toString();
}

/**
 * Returns the time step the code matched, or null. A code is accepted for the current step and
 * one step either side. A match at or before `lastStep` is a replay and returns null: the caller
 * stores the returned step and passes it back next time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: number | null,
): number | null {
  const candidate = code.trim();
  if (!/^[0-9]{6}$/.test(candidate)) return null;

  const totp = totpFor(OTPAuth.Secret.fromBase32(secret), 'verify');
  const current = Math.floor(now.getTime() / PERIOD_MS);
  const given = Buffer.from(candidate, 'utf8');

  // Check every step in the window without stopping early, so timing does not reveal which matched.
  let matched: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(totp.generate({ timestamp: step * PERIOD_MS }), 'utf8');
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      matched = matched === null ? step : Math.max(matched, step);
    }
  }

  if (matched === null) return null;
  if (lastStep !== null && matched <= lastStep) return null;
  return matched;
}

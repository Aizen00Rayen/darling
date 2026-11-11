import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashing: Node's built-in scrypt (no native module). Stored as `scrypt$N$r$p$salt$hash`
// (salt and hash base64url). Hashing and verifying are asynchronous (libuv thread pool), so a login
// never blocks the event loop. Server-only.

const N = 16_384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// scrypt needs about 128 * N * r bytes; Node's default limit is 32 MiB, so state it explicitly.
const MAXMEM = 64 * 1024 * 1024;
// Bounds for parameters read back from a stored hash: a corrupted row must never trigger a huge allocation.
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(password, 'utf8'), salt, keyLength, { N: n, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P, KEY_BYTES);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

const POSITIVE_INT = /^[1-9][0-9]{0,9}$/;

/** Decodes a base64url part only if it is the canonical encoding. */
function canonical(part: string): Buffer | null {
  if (part === '' || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  const bytes = Buffer.from(part, 'base64url');
  return bytes.toString('base64url') === part ? bytes : null;
}

/** Never throws: a malformed or unsupported stored hash simply does not verify. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nText, rText, pText, saltText, keyText] = parts as [string, string, string, string, string, string];
    if (!POSITIVE_INT.test(nText) || !POSITIVE_INT.test(rText) || !POSITIVE_INT.test(pText)) return false;
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (n < 2 || n > MAX_N || (n & (n - 1)) !== 0 || r > MAX_R || p > MAX_P) return false;
    const salt = canonical(saltText);
    const expected = canonical(keyText);
    if (!salt || !expected || salt.length < 8 || expected.length < 16 || expected.length > 128) return false;
    const actual = await derive(password, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random string, computed once when the module loads (asynchronously, so nothing blocks).
 * Login verifies against it when the account does not exist, so unknown and known emails cost the same.
 * A promise, so every caller simply awaits it.
 */
export const DUMMY_HASH: Promise<string> = hashPassword(randomBytes(32).toString('base64url'));
DUMMY_HASH.catch(() => undefined); // a failure is reported to whoever awaits it, not as an unhandled rejection

/** A 256-bit random token (base64url, 43 characters) and the sha256 hex digest stored in the database. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Plain sha256: the input is already 256 bits of randomness, so no salt or pepper is needed (spec section 3). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ENCRYPTION_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
const INVALID = 'invalid encrypted secret';

function assertKey(key: Buffer): void {
  if (key.length !== AES_KEY_BYTES) throw new Error('encryption key must be exactly 32 bytes');
}

/** AES-256-GCM. Output: `v1:<iv>:<tag>:<ciphertext>`, each part base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [ENCRYPTION_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function decodeCanonical(part: string): Buffer {
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error(INVALID);
  return bytes;
}

/** Throws on a wrong key, any tampering, or malformed input; never returns garbage. */
export function decryptSecret(enc: string, key: Buffer): string {
  assertKey(key);
  const parts = enc.split(':');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) throw new Error(INVALID);
  const iv = decodeCanonical(parts[1] as string);
  const tag = decodeCanonical(parts[2] as string);
  const ciphertext = decodeCanonical(parts[3] as string);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error(INVALID);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(INVALID); // never surface the underlying reason
  }
}

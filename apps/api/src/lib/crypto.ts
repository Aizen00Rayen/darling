import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import argon2 from 'argon2';

// OWASP "argon2id, 19 MiB, 2 iterations, 1 lane" minimum profile.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, ARGON2_OPTIONS);
}

/** Never throws: a malformed stored hash simply does not verify. */
export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

/**
 * A real argon2id hash of a random string, computed once when the module loads. Login verifies
 * against it when the email is unknown, so unknown and known emails cost the same time.
 */
export const DUMMY_HASH: string = await hashPassword(randomBytes(32).toString('base64url'));

/** A 256-bit random token (base64url, 43 characters) and the sha256 hex digest stored in the database. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const ENCRYPTION_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const INVALID = 'invalid encrypted secret';

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('encryption key must be exactly 32 bytes');
}

/** AES-256-GCM. Output: `v1:<iv>:<tag>:<ciphertext>`, each part base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/** Decodes a base64url part only if it is the canonical encoding (rejects stray bits and padding). */
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
    // Do not surface the underlying reason: it only helps an attacker.
    throw new Error(INVALID);
  }
}

/** HMAC-SHA256 hex: lets us store IPs and user agents as pseudonyms rather than raw values. */
export function pepperHash(value: string, pepper: Buffer): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

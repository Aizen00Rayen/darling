import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DUMMY_HASH,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  newToken,
  pepperHash,
  verifyPassword,
} from './crypto';

const key = Buffer.alloc(32, 7);

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('Rose-gloss-2026');
    expect(await verifyPassword(hash, 'Rose-gloss-2026')).toBe(true);
    expect(await verifyPassword(hash, 'Rose-gloss-2027')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('uses argon2id with the specified cost and a fresh salt each time', async () => {
    const a = await hashPassword('Rose-gloss-2026');
    const b = await hashPassword('Rose-gloss-2026');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('returns false (never throws) for a malformed stored hash', async () => {
    expect(await verifyPassword('placeholder-hash', 'whatever')).toBe(false);
    expect(await verifyPassword('', 'whatever')).toBe(false);
  });

  it('DUMMY_HASH is a real argon2id hash that no ordinary password matches', async () => {
    expect(DUMMY_HASH).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(verifyPassword(DUMMY_HASH, 'Rose-gloss-2026')).resolves.toBe(false);
    await expect(verifyPassword(DUMMY_HASH, '')).resolves.toBe(false);
  });
});

describe('tokens', () => {
  it('newToken is 32 random bytes in base64url with a matching sha256 hex hash', () => {
    const { token, hash } = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
  });

  it('never repeats and hashToken is deterministic', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newToken().token));
    expect(tokens.size).toBe(50);
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('JBSWY3DP', key), key)).toBe('JBSWY3DP');
    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
    expect(decryptSecret(encryptSecret('élève 💄', key), key)).toBe('élève 💄');
  });

  it('uses the v1:<iv>:<tag>:<ct> format with a 12-byte random IV', () => {
    const enc = encryptSecret('JBSWY3DP', key);
    const parts = enc.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(Buffer.from(parts[1] as string, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2] as string, 'base64url')).toHaveLength(16);
    expect(encryptSecret('JBSWY3DP', key)).not.toBe(enc);
  });

  function flip(char: string): string {
    return char === 'A' ? 'B' : 'A';
  }

  it.each([
    ['iv', 1],
    ['tag', 2],
    ['ciphertext', 3],
  ])('rejects a tampered %s (first and last character)', (_name, index) => {
    const parts = encryptSecret('JBSWY3DPJBSWY3DPJBSWY3DP', key).split(':');
    const part = parts[index] as string;
    for (const at of [0, part.length - 1]) {
      const tampered = [...parts];
      tampered[index] = part.slice(0, at) + flip(part[at] as string) + part.slice(at + 1);
      expect(() => decryptSecret(tampered.join(':'), key)).toThrow();
    }
  });

  it('rejects the last character of every part changed to any other base64url character', () => {
    const enc = encryptSecret('JBSWY3DP', key);
    const parts = enc.split(':');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const index of [1, 2, 3]) {
      const part = parts[index] as string;
      for (const c of alphabet) {
        if (c === part.at(-1)) continue;
        const tampered = [...parts];
        tampered[index] = part.slice(0, -1) + c;
        expect(() => decryptSecret(tampered.join(':'), key)).toThrow();
      }
    }
  });

  it('rejects the wrong key and a key of the wrong length', () => {
    const enc = encryptSecret('JBSWY3DP', key);
    expect(() => decryptSecret(enc, Buffer.alloc(32, 8))).toThrow();
    expect(() => decryptSecret(enc, Buffer.alloc(16, 7))).toThrow();
    expect(() => encryptSecret('x', Buffer.alloc(16, 7))).toThrow();
  });

  it('rejects malformed input instead of returning garbage', () => {
    const [v, iv, tag, ct] = encryptSecret('JBSWY3DP', key).split(':') as [string, string, string, string];
    const malformed = [
      '',
      'v1',
      'v1:::',
      'v1:a:b',
      `v2:${iv}:${tag}:${ct}`,
      `${iv}:${tag}:${ct}`,
      `${v}:${iv}:${tag}`,
      `${v}:${iv}:${tag}:${ct}:extra`,
      `${v}:${iv}:${tag}:${ct}=`,
      `${v}:${iv}:${tag}:${ct}!`,
      `${v}:${iv}: ${tag}:${ct}`,
      `${v}:${iv.slice(0, 8)}:${tag}:${ct}`,
      `${v}:${iv}:${tag.slice(0, 10)}:${ct}`,
      `${v}:${iv}::${ct}`,
      `${v}::${tag}:${ct}`,
      'not an encrypted secret at all',
      'JBSWY3DP',
    ];
    for (const input of malformed) expect(() => decryptSecret(input, key), input).toThrow();
  });

  it('rejects an authentic ciphertext whose tag was truncated (short tags are not accepted)', () => {
    const [v, iv, tag, ct] = encryptSecret('JBSWY3DP', key).split(':') as [string, string, string, string];
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => decryptSecret(`${v}:${iv}:${short}:${ct}`, key)).toThrow();
  });

  it('does not leak the plaintext in the thrown error', () => {
    const enc = encryptSecret('TOPSECRETVALUE', key);
    try {
      decryptSecret(enc, Buffer.alloc(32, 9));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('TOPSECRETVALUE');
    }
  });
});

describe('pepperHash', () => {
  it('is HMAC-SHA256 hex, keyed by the pepper', () => {
    const pepper = randomBytes(32);
    const a = pepperHash('203.0.113.7', pepper);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pepperHash('203.0.113.7', pepper)).toBe(a);
    expect(pepperHash('203.0.113.8', pepper)).not.toBe(a);
    expect(pepperHash('203.0.113.7', randomBytes(32))).not.toBe(a);
  });

  it('matches a known HMAC-SHA256 vector', () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
    expect(pepperHash('what do ya want for nothing?', Buffer.from('Jefe'))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

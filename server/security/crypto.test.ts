import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DUMMY_HASH,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  newToken,
  verifyPassword,
} from './crypto';

const key = Buffer.alloc(32, 7);

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('Rose-gloss-2026');
    expect(await verifyPassword(hash, 'Rose-gloss-2026')).toBe(true);
    expect(await verifyPassword(hash, 'Rose-gloss-2027')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
    expect(await verifyPassword(hash, 'rose-gloss-2026')).toBe(false);
  });

  it('uses the scrypt$N$r$p$salt$hash format with N=16384, r=8, p=1, a 16-byte salt and a 64-byte key', async () => {
    const hash = await hashPassword('Rose-gloss-2026');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(parts[4] as string, 'base64url')).toHaveLength(16);
    expect(Buffer.from(parts[5] as string, 'base64url')).toHaveLength(64);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  });

  it('uses a fresh salt every time', async () => {
    const a = await hashPassword('Rose-gloss-2026');
    const b = await hashPassword('Rose-gloss-2026');
    expect(a).not.toBe(b);
  });

  it('matches an independently computed scrypt derivation', async () => {
    const hash = await hashPassword('Rose-gloss-2026');
    const [, n, r, p, salt, derived] = hash.split('$') as string[];
    const expected = scryptSync('Rose-gloss-2026', Buffer.from(salt as string, 'base64url'), 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    expect(expected.toString('base64url')).toBe(derived);
  });

  it('is asynchronous: hashing does not block the event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    await hashPassword('Rose-gloss-2026');
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('handles unicode and long passwords', async () => {
    const pw = 'mot-de-passe-élève-💄-'.repeat(8);
    const hash = await hashPassword(pw);
    expect(await verifyPassword(hash, pw)).toBe(true);
    expect(await verifyPassword(hash, pw.normalize('NFD'))).toBe(false);
  });

  it('returns false (never throws) for malformed stored hashes', async () => {
    const good = await hashPassword('Rose-gloss-2026');
    const [s, n, r, p, salt, derived] = good.split('$') as string[];
    const malformed = [
      '',
      'placeholder-hash',
      'scrypt',
      `${s}$${n}$${r}$${p}$${salt}`,
      `${s}$${n}$${r}$${p}$${salt}$${derived}$extra`,
      `${s}$0$${r}$${p}$${salt}$${derived}`,
      `${s}$-16384$${r}$${p}$${salt}$${derived}`,
      `${s}$16385$${r}$${p}$${salt}$${derived}`, // not a power of two
      `${s}$abc$${r}$${p}$${salt}$${derived}`,
      `${s}$${n}$0$${p}$${salt}$${derived}`,
      `${s}$${n}$${r}$0$${p}$${derived}`,
      `${s}$99999999999$${r}$${p}$${salt}$${derived}`, // absurd cost: must not allocate
      `${s}$${n}$${r}$${p}$$${derived}`,
      `${s}$${n}$${r}$${p}$${salt}$`,
      `${s}$${n}$${r}$${p}$${salt}!$${derived}`,
      `${s}$${n}$${r}$${p}$${salt}$${derived.slice(0, 20)}`, // truncated key
      `bcrypt$${n}$${r}$${p}$${salt}$${derived}`,
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
    ];
    for (const hash of malformed) expect(await verifyPassword(hash, 'Rose-gloss-2026'), hash).toBe(false);
  });

  it('rejects a hash whose derived key was altered by one character', async () => {
    const hash = await hashPassword('Rose-gloss-2026');
    const last = hash.slice(-1);
    const altered = hash.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(await verifyPassword(altered, 'Rose-gloss-2026')).toBe(false);
  });

  it('DUMMY_HASH is a real scrypt hash with the same cost that no ordinary password matches', async () => {
    const dummy = await DUMMY_HASH;
    expect(dummy).toMatch(/^scrypt\$16384\$8\$1\$/);
    await expect(verifyPassword(dummy, 'Rose-gloss-2026')).resolves.toBe(false);
    await expect(verifyPassword(dummy, '')).resolves.toBe(false);
  });
});

describe('tokens', () => {
  it('newToken is 32 random bytes in base64url with a matching sha256 hex hash', () => {
    const { token, hash } = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
  });

  it('never repeats and hashToken is deterministic sha256', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newToken().token));
    expect(tokens.size).toBe(50);
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

  it('uses the v1:<iv>:<tag>:<ct> format with a 12-byte random IV and a 16-byte tag', () => {
    const enc = encryptSecret('JBSWY3DP', key);
    const parts = enc.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(Buffer.from(parts[1] as string, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2] as string, 'base64url')).toHaveLength(16);
    expect(encryptSecret('JBSWY3DP', key)).not.toBe(enc);
  });

  it.each([
    ['iv', 1],
    ['tag', 2],
    ['ciphertext', 3],
  ])('rejects a tampered %s (first and last character)', (_name, index) => {
    const parts = encryptSecret('JBSWY3DPJBSWY3DPJBSWY3DP', key).split(':');
    const part = parts[index] as string;
    const flip = (c: string) => (c === 'A' ? 'B' : 'A');
    for (const at of [0, part.length - 1]) {
      const tampered = [...parts];
      tampered[index] = part.slice(0, at) + flip(part[at] as string) + part.slice(at + 1);
      expect(() => decryptSecret(tampered.join(':'), key)).toThrow();
    }
  });

  it('rejects the last character of every part changed to any other base64url character', () => {
    const parts = encryptSecret('JBSWY3DP', key).split(':');
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
      '', 'v1', 'v1:::', 'v1:a:b',
      `v2:${iv}:${tag}:${ct}`, `${iv}:${tag}:${ct}`, `${v}:${iv}:${tag}`, `${v}:${iv}:${tag}:${ct}:extra`,
      `${v}:${iv}:${tag}:${ct}=`, `${v}:${iv}:${tag}:${ct}!`, `${v}:${iv}: ${tag}:${ct}`,
      `${v}:${iv.slice(0, 8)}:${tag}:${ct}`, `${v}:${iv}:${tag.slice(0, 10)}:${ct}`,
      `${v}:${iv}::${ct}`, `${v}::${tag}:${ct}`, 'not an encrypted secret at all', 'JBSWY3DP',
    ];
    for (const input of malformed) expect(() => decryptSecret(input, key), input).toThrow();
  });

  it('rejects an authentic ciphertext whose tag was truncated', () => {
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

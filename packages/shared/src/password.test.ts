import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCommonPasswords } from '../scripts/common-passwords-lib.mjs';
import { COMMON_PASSWORDS } from './common-passwords';
import { passwordProblem } from './password';

const TOO_COMMON = 'Ce mot de passe est trop courant. Choisissez-en un autre.';

describe('passwordProblem', () => {
  it('rejects short passwords', () => {
    expect(passwordProblem('court')).toMatch(/10 caractères/);
    expect(passwordProblem('')).toBe('Le mot de passe doit contenir au moins 10 caractères.');
  });

  it.each([
    '1234567890',
    'qwertyuiop',
    'password12',
    'password1234',
    'iloveyou12',
    '1q2w3e4r5t',
    '0123456789',
    'password123',
    'Password123',
    'PASSWORD123',
  ])('rejects the common password %s, case-insensitively', (password) => {
    expect(passwordProblem(password)).toBe(TOO_COMMON);
  });

  it('rejects over-long passwords', () => {
    expect(passwordProblem('x'.repeat(201))).toBe('Le mot de passe est trop long.');
    expect(passwordProblem('Rose-gloss-2026'.padEnd(200, 'x'))).toBeNull();
  });

  it('accepts a good passphrase', () => {
    expect(passwordProblem('Rose-gloss-2026')).toBeNull();
  });
});

describe('COMMON_PASSWORDS', () => {
  it('holds a real list of 10+ character entries, all lower-case', () => {
    const long = [...COMMON_PASSWORDS].filter((entry) => entry.length >= 10);
    expect(long.length).toBeGreaterThanOrEqual(1000);
    for (const entry of COMMON_PASSWORDS) expect(entry).toBe(entry.toLowerCase());
  });

  it('matches what the generator builds from data/common-passwords.txt (no drift)', () => {
    const data = readFileSync(fileURLToPath(new URL('../data/common-passwords.txt', import.meta.url)), 'utf8');
    expect(buildCommonPasswords(data)).toEqual([...COMMON_PASSWORDS]);
  });
});

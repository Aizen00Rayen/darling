import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS } from './common-passwords';
import { passwordProblem } from './password';

describe('passwordProblem', () => {
  it('rejects short passwords', () => {
    expect(passwordProblem('court')).toMatch(/10 caractères/);
    expect(passwordProblem('')).toBe('Le mot de passe doit contenir au moins 10 caractères.');
  });

  it('rejects common passwords, case-insensitively', () => {
    expect(passwordProblem('password123')).toMatch(/trop courant/);
    expect(passwordProblem('PASSWORD123')).toMatch(/trop courant/);
    expect(passwordProblem('password123')).toBe('Ce mot de passe est trop courant. Choisissez-en un autre.');
  });

  it('rejects over-long passwords', () => {
    expect(passwordProblem('x'.repeat(201))).toBe('Le mot de passe est trop long.');
    expect(passwordProblem('Rose-gloss-2026'.padEnd(200, 'x'))).toBeNull();
  });

  it('accepts a good passphrase', () => {
    expect(passwordProblem('Rose-gloss-2026')).toBeNull();
  });

  it('ships a lower-case, duplicate-free list', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(1000);
    for (const entry of COMMON_PASSWORDS) expect(entry).toBe(entry.toLowerCase());
  });
});

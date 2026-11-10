import { COMMON_PASSWORDS } from './common-passwords';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/** Returns a French message describing why the password is refused, or null if it is acceptable. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`;
  if (pw.length > PASSWORD_MAX_LENGTH) return 'Le mot de passe est trop long.';
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'Ce mot de passe est trop courant. Choisissez-en un autre.';
  return null;
}

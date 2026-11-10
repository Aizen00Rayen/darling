export const PHONE_ERROR = 'Saisissez un numéro algérien valide (10 chiffres ou +213).';

const LOCAL = /^0[567]\d{8}$/;
const INTERNATIONAL = /^\+213([567]\d{8})$/;

/**
 * Normalises an Algerian mobile number to the local `0[567]xxxxxxxx` form.
 * Accepts the local and the `+213` forms, with or without spaces. Anything
 * else returns null.
 */
export function normalizePhone(input: string): string | null {
  const compact = input.replace(/\s/g, '');
  if (LOCAL.test(compact)) return compact;
  const international = INTERNATIONAL.exec(compact);
  return international ? `0${international[1]}` : null;
}

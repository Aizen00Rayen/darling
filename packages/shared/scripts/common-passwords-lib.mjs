// Pure helpers shared by scripts/build-common-passwords.mjs and its drift-guard test.

/**
 * Passwords that must always be refused even if a source list lacks them.
 * `password123` is not in the SecLists lists' first entries; the rest are the
 * well-known 10+ character examples the policy is tested against.
 */
export const EXTRA = [
  'password123',
  '1234567890',
  'qwertyuiop',
  'password12',
  'password1234',
  'iloveyou12',
  '1q2w3e4r5t',
  '0123456789',
];

/** Minimum length (passwordProblem rejects anything shorter before looking at the list). */
export const MIN_LENGTH = 10;
/** Maximum number of entries taken from the source list. */
export const MAX_ENTRIES = 5000;

/**
 * Source text (one password per line) to the data file entries: lower-cased,
 * length >= MIN_LENGTH, de-duplicated, in file order, first MAX_ENTRIES kept.
 * @param {string} text
 * @returns {string[]}
 */
export function filterSource(text) {
  const seen = new Set();
  for (const line of text.split('\n')) {
    const entry = line.replace(/\r$/, '').toLowerCase();
    if (entry.length >= MIN_LENGTH && !seen.has(entry)) {
      seen.add(entry);
      if (seen.size === MAX_ENTRIES) break;
    }
  }
  return [...seen];
}

/**
 * Data file text to the final ordered entries: trimmed, lower-cased,
 * de-duplicated, with EXTRA appended when missing.
 * @param {string} dataText
 * @returns {string[]}
 */
export function buildCommonPasswords(dataText) {
  const lines = [...dataText.split('\n'), ...EXTRA].map((line) => line.trim().toLowerCase());
  return [...new Set(lines.filter((line) => line.length > 0))];
}

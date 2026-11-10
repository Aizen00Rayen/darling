const MAX_LENGTH = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Returns `input` when it is a safe same-site path to redirect to, otherwise `fallback`.
 *
 * Accepted: starts with a single `/`, at most 512 characters, no control characters, no backslash,
 * decodes cleanly (decoded form is checked too, so `/%2F/x`, `/%5Cx`, `/%0d%0a` are rejected), no empty
 * (`//`) or dot (`.`/`..`) path segments (decision: reject `/..//evil.com` outright rather than
 * normalising it), and does not point at the login page itself or at `/api`.
 */
export function safeNextPath(input: string | null | undefined, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  if (input.length === 0 || input.length > MAX_LENGTH) return fallback;
  if (!input.startsWith('/') || input.startsWith('//')) return fallback;

  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return fallback;
  }

  for (const form of [input, decoded]) {
    if (CONTROL_CHARS.test(form) || form.includes('\\')) return fallback;
    if (!form.startsWith('/') || form.startsWith('//')) return fallback;
  }

  const pathOnly = decoded.split(/[?#]/, 1)[0]!;
  const segments = pathOnly.split('/').slice(1);
  const lastIndex = segments.length - 1;
  // An empty segment is only fine as the trailing one (`/admin/`); `//` and dot segments are not.
  if (segments.some((s, i) => s === '.' || s === '..' || (s === '' && i !== lastIndex))) return fallback;

  const first = segments[0]!.toLowerCase();
  if (first === 'connexion' || first === 'api') return fallback;

  return input;
}

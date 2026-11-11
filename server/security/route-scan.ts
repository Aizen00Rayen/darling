// Source scanner behind the route-file tests (access-matrix.test.ts). It reads `app/api/**/route.ts` as TEXT and
// checks the access conventions, so a route that skips them fails a test instead of shipping:
//   - the file exports `access`: either ONE rule (`{ kind: ... }`) used as `withAccess(access, ...)` by every handler,
//     or PER-METHOD rules (`{ GET: { kind: ... }, POST: { kind: ... } }`) where each handler uses its own,
//     `withAccess(access.GET, ...)`; the keys must be exactly the exported methods;
//   - every handler is built with withAccess (never a bare function).

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The HTTP methods a route file exports (`export const GET`, `export async function POST`, ...). */
export function exportedMethods(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((m) => new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${m}\\b`).test(source));
}

/** The text of the object literal assigned to `export const access`, or null (no export, or not an object literal). */
function accessLiteral(source: string): string | null {
  const start = /export\s+const\s+access\b[^=]*=\s*\{/.exec(source);
  if (!start) return null;
  let depth = 0;
  for (let i = start.index + start[0].length - 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start.index + start[0].length - 1, i + 1);
    }
  }
  return null;
}

/** The methods that have their own rule when `access` is per-method, null when it is one rule for the whole route. */
export function perMethodAccessKeys(source: string): HttpMethod[] | null {
  const literal = accessLiteral(source);
  if (literal === null) return null;
  // Only the top level of the literal counts: blank out nested braces before looking for `METHOD:` keys.
  let flat = '';
  let depth = 0;
  for (const c of literal) {
    if (c === '{') depth += 1;
    if (depth === 1) flat += c;
    if (c === '}') depth -= 1;
  }
  if (/\bkind\s*:/.test(flat)) return null;
  return HTTP_METHODS.filter((m) => new RegExp(`(?:^|[{,\\s])${m}\\s*:`).test(flat));
}

/** Everything wrong with how a route file declares and applies its access rules (empty when fine). */
export function accessProblems(source: string): string[] {
  const problems: string[] = [];
  if (!/export\s+const\s+access\b/.test(source)) problems.push('does not export `access`');
  const methods = exportedMethods(source);
  if (methods.length === 0) problems.push('exports no HTTP method handler');
  const keys = perMethodAccessKeys(source);
  if (keys !== null) {
    for (const m of methods) if (!keys.includes(m)) problems.push(`${m} has no entry in the per-method \`access\``);
    for (const k of keys) if (!methods.includes(k)) problems.push(`\`access\` has an entry for ${k}, which the route does not export`);
  }
  for (const m of methods) {
    const wanted = keys === null ? 'access' : `access\\.${m}`;
    const wrapper = new RegExp(`export\\s+const\\s+${m}\\s*=\\s*withAccess(?:<[^>]*>)?\\(\\s*${wanted}\\s*[,)]`);
    if (!wrapper.test(source)) {
      problems.push(keys === null ? `${m} must be built with withAccess(access, ...)` : `${m} must be built with withAccess(access.${m}, ...)`);
    }
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(source)) problems.push(`${m} must not be a bare function`);
  }
  return problems;
}

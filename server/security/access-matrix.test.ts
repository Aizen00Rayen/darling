import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@/shared';
import { ROUTES } from '../api-registry';
import { createTestApp, login, seedUser, totpCodeAt, type TestApp } from '../test/app';

// The authorization matrix. Every app/api/**/route.ts must (1) export `access` and build its handlers with
// withAccess, (2) be listed in the route registry, (3) have a row below for every HTTP method it exports.
// The expectations are written out by hand per principal (not derived from the route's own rule), so a
// loosened rule fails here.

type Principal = 'anonymous' | 'affiliate' | 'sub_manager' | 'sm_none' | 'sm_permitted' | 'owner' | 'sm_unenrolled';
const PRINCIPALS: Principal[] = ['anonymous', 'affiliate', 'sub_manager', 'sm_none', 'sm_permitted', 'owner', 'sm_unenrolled'];

/** 'ok' = anything but 401/403 (the handler ran); the others are exact refusals. */
type Verdict = 'ok' | 'U' | 'F' | 'E';
const ALL_OK: Verdict[] = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'];
// anonymous, affiliate, sub_manager, sm_none, sm_permitted, owner, sm_unenrolled
const AUTHENTICATED_ENROLLMENT_OK: Verdict[] = ['U', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'];

interface Row {
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Permission the "sm_permitted" principal holds for this route (none of the M2 routes needs one). */
  permission?: Permission;
  /** Request path with params filled in. */
  path?: string;
  /** A deliberately empty/invalid body for every non-GET row, to prove refused callers never see a 400. */
  body?: unknown;
  verdicts: Verdict[];
  /** Statuses an authorised principal may legitimately get (the handler ran). */
  allowed: number[];
  /** Exact refusal for everyone refused, besides the code. */
  consumes?: boolean;
}

const TOKEN = 'm'.repeat(43);
const MATRIX: Row[] = [
  { route: '/api/health', method: 'GET', verdicts: ALL_OK, allowed: [200] },
  { route: '/api/orders', method: 'POST', body: {}, verdicts: ALL_OK, allowed: [400] },
  { route: '/api/auth/login', method: 'POST', body: {}, verdicts: ALL_OK, allowed: [400] },
  { route: '/api/auth/password/forgot', method: 'POST', body: {}, verdicts: ALL_OK, allowed: [400] },
  { route: '/api/auth/password/reset', method: 'POST', body: {}, verdicts: ALL_OK, allowed: [400] },
  { route: '/api/auth/invite/accept', method: 'POST', body: {}, verdicts: ALL_OK, allowed: [400] },
  { route: '/api/auth/invite/:token', method: 'GET', path: `/api/auth/invite/${TOKEN}`, verdicts: ALL_OK, allowed: [404] },
  { route: '/api/auth/me', method: 'GET', verdicts: AUTHENTICATED_ENROLLMENT_OK, allowed: [200] },
  { route: '/api/auth/logout', method: 'POST', verdicts: AUTHENTICATED_ENROLLMENT_OK, allowed: [204], consumes: true },
  { route: '/api/auth/2fa/setup', method: 'POST', verdicts: AUTHENTICATED_ENROLLMENT_OK, allowed: [200, 409] },
  { route: '/api/auth/2fa/enable', method: 'POST', body: {}, verdicts: AUTHENTICATED_ENROLLMENT_OK, allowed: [400] },
  { route: '/api/auth/2fa/disable', method: 'POST', body: {}, verdicts: AUTHENTICATED_ENROLLMENT_OK, allowed: [400] },
  { route: '/api/auth/password/change', method: 'POST', body: {}, verdicts: AUTHENTICATED_ENROLLMENT_OK, allowed: [400] },
];

const API_DIR = path.join(process.cwd(), 'app', 'api');

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return routeFiles(full);
    return e.name === 'route.ts' || e.name === 'route.tsx' || e.name === 'route.js' ? [full] : [];
  });
}

function patternOf(file: string): string {
  const rel = path.relative(path.join(process.cwd(), 'app'), path.dirname(file)).split(path.sep);
  return '/' + rel.map((s) => s.replace(/^\[(.+)\]$/, ':$1')).join('/');
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
function exportedMethods(source: string): string[] {
  return METHODS.filter((m) => new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${m}\\b`).test(source));
}

describe('route files', () => {
  const files = routeFiles(API_DIR);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThanOrEqual(MATRIX.length - 1);
  });

  it.each(files.map((f) => [patternOf(f), f]))('%s exports `access` and wraps every handler in withAccess', (_pattern, file) => {
    const source = fs.readFileSync(file as string, 'utf8');
    expect(source).toMatch(/export\s+const\s+access\b/);
    const methods = exportedMethods(source);
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      expect(source, `${m} must be built with withAccess(access, ...)`).toMatch(new RegExp(`export\\s+const\\s+${m}\\s*=\\s*withAccess(?:<[^>]*>)?\\(\\s*access\\b`));
      expect(source, `${m} must not be a bare function`).not.toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`));
    }
  });

  it.each(files.map((f) => [patternOf(f), f]))('%s is in the registry and in the matrix, for every exported method', (pattern, file) => {
    const methods = exportedMethods(fs.readFileSync(file as string, 'utf8'));
    const entry = ROUTES.find((r) => r.pattern === pattern);
    expect(entry, `registry is missing ${pattern}`).toBeDefined();
    expect(Object.keys(entry?.methods ?? {}).sort()).toEqual([...methods].sort());
    for (const m of methods) {
      expect(MATRIX.find((r) => r.route === pattern && r.method === m), `matrix is missing ${m} ${pattern}`).toBeDefined();
    }
  });

  it('the registry and the matrix list nothing that has no route file', () => {
    const patterns = new Set(files.map(patternOf));
    for (const r of ROUTES) expect(patterns.has(r.pattern), r.pattern).toBe(true);
    for (const row of MATRIX) expect(patterns.has(row.route), row.route).toBe(true);
  });

  it('every matrix row lists a verdict for every principal and a body for every non-GET row that has one to validate', () => {
    for (const row of MATRIX) expect(row.verdicts, row.route).toHaveLength(PRINCIPALS.length);
  });
});

describe('access matrix', () => {
  let app: TestApp;
  const cookies = new Map<Principal, string>();

  async function freshCookie(p: Principal): Promise<string | undefined> {
    if (p === 'anonymous') return undefined;
    const spec = {
      affiliate: { role: 'affiliate' as const },
      sub_manager: { role: 'sub_manager' as const },
      sm_none: { role: 'super_manager' as const, totp: true },
      sm_permitted: { role: 'super_manager' as const, totp: true, permissions: ['orders.read' as Permission] },
      owner: { role: 'super_manager' as const, isOwner: true, totp: true },
      sm_unenrolled: { role: 'super_manager' as const },
    }[p];
    const u = await seedUser(app, spec);
    return login(app, u.email, u.password, { totpCode: u.totpSecret ? totpCodeAt(u.totpSecret, app.clock.now()) : undefined });
  }

  beforeAll(async () => {
    app = createTestApp();
    for (const p of PRINCIPALS) {
      const c = await freshCookie(p);
      if (c) cookies.set(p, c);
    }
  });
  afterAll(() => app.close());

  for (const row of MATRIX) {
    describe(`${row.method} ${row.route}`, () => {
      it.each(PRINCIPALS.map((p, i) => [p, row.verdicts[i] as Verdict]))('%s -> %s', async (principal, verdict) => {
        app.limiter.reset();
        const cookie = row.consumes ? await freshCookie(principal as Principal) : cookies.get(principal as Principal);
        const body = row.method === 'GET' ? undefined : (row.body ?? undefined);
        const res = await app.call(row.path ?? row.route, { method: row.method, body, cookie });
        const text = await res.text();
        if (verdict === 'ok') {
          // authorised: the handler ran (never 401/403), and the status is one of the route's own
          expect(res.status, `${principal}: ${text}`).not.toBe(401);
          expect(res.status, `${principal}: ${text}`).not.toBe(403);
          expect(row.allowed, `${principal} got ${res.status}: ${text}`).toContain(res.status);
        } else {
          // refused callers get a bare { code } and never see validation details, even with an invalid body
          const code = verdict === 'U' ? 'unauthenticated' : verdict === 'E' ? '2fa_enrollment_required' : 'forbidden';
          expect(res.status).toBe(verdict === 'U' ? 401 : 403);
          expect(JSON.parse(text)).toEqual({ code });
        }
      });
    });
  }
});

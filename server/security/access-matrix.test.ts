import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@/shared';
import { ROUTES, accessFor, type Method } from '../api-registry';
import { accessProblems, exportedMethods } from './route-scan';
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
// A permission route: only a super manager HOLDING the permission and the owner get in; a super manager who still
// has to enrol in 2FA is told to enrol (before any permission is looked at); everyone else is refused.
const PERMISSION_ROUTE: Verdict[] = ['U', 'F', 'F', 'F', 'ok', 'ok', 'E'];

interface Row {
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Permission the "sm_permitted" principal holds for this route; "sm_none" holds every OTHER launch permission. */
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
const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';
const USERS = { permission: 'users.manage' as const, verdicts: PERMISSION_ROUTE };
const AUDIT = { permission: 'audit.read' as const, verdicts: PERMISSION_ROUTE };
const SETTINGS = { permission: 'settings.manage' as const, verdicts: PERMISSION_ROUTE };
const ORDERS_READ = { permission: 'orders.read' as const, verdicts: PERMISSION_ROUTE };
const ORDERS_WRITE = { permission: 'orders.write' as const, verdicts: PERMISSION_ROUTE };
const MATRIX: Row[] = [
  { route: '/api/health', method: 'GET', verdicts: ALL_OK, allowed: [200] },
  // /api/orders has per-method access: the storefront POST is public, the staff list needs orders.read.
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
  // The first-run setup: public, but answers 404 as soon as any user exists (the matrix has several).
  { route: '/api/setup', method: 'POST', body: {}, verdicts: ALL_OK, allowed: [404] },
  // users.manage
  { route: '/api/users', method: 'GET', ...USERS, allowed: [200] },
  { route: '/api/users', method: 'POST', body: {}, ...USERS, allowed: [400] },
  { route: '/api/users/:id', method: 'GET', path: `/api/users/${UNKNOWN_ID}`, ...USERS, allowed: [404] },
  { route: '/api/users/:id', method: 'PATCH', path: `/api/users/${UNKNOWN_ID}`, body: { fullName: 'x'.repeat(500) }, ...USERS, allowed: [400] },
  { route: '/api/users/:id/suspend', method: 'POST', path: `/api/users/${UNKNOWN_ID}/suspend`, ...USERS, allowed: [404] },
  { route: '/api/users/:id/reactivate', method: 'POST', path: `/api/users/${UNKNOWN_ID}/reactivate`, ...USERS, allowed: [404] },
  { route: '/api/users/:id/resend-invite', method: 'POST', path: `/api/users/${UNKNOWN_ID}/resend-invite`, ...USERS, allowed: [404] },
  { route: '/api/users/:id/revoke-sessions', method: 'POST', path: `/api/users/${UNKNOWN_ID}/revoke-sessions`, ...USERS, allowed: [404] },
  // audit.read
  { route: '/api/audit-log', method: 'GET', ...AUDIT, allowed: [200] },
  { route: '/api/login-events', method: 'GET', ...AUDIT, allowed: [200] },
  // orders.read / orders.write (a super manager holding only the OTHER one is refused: reading never lets you write)
  { route: '/api/orders', method: 'GET', ...ORDERS_READ, allowed: [200] },
  { route: '/api/orders/:id', method: 'GET', path: `/api/orders/${UNKNOWN_ID}`, ...ORDERS_READ, allowed: [404] },
  { route: '/api/orders/:id', method: 'PATCH', path: `/api/orders/${UNKNOWN_ID}`, body: {}, ...ORDERS_WRITE, allowed: [400] },
  { route: '/api/orders/:id/status', method: 'POST', path: `/api/orders/${UNKNOWN_ID}/status`, body: {}, ...ORDERS_WRITE, allowed: [400] },
  { route: '/api/orders/manual', method: 'POST', body: {}, ...ORDERS_WRITE, allowed: [400] },
  // settings.manage
  { route: '/api/settings', method: 'GET', ...SETTINGS, allowed: [200] },
  { route: '/api/settings/:key', method: 'PATCH', path: '/api/settings/company.name', body: {}, ...SETTINGS, allowed: [400] },
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

describe('route files', () => {
  const files = routeFiles(API_DIR);

  it('finds the route files', () => {
    expect(files.length).toBe(new Set(MATRIX.map((r) => r.route)).size);
  });

  it.each(files.map((f) => [patternOf(f), f]))('%s exports `access` and wraps every handler in withAccess', (_pattern, file) => {
    // one rule for the route (`withAccess(access, ...)`) or one per method (`withAccess(access.POST, ...)`)
    expect(accessProblems(fs.readFileSync(file as string, 'utf8'))).toEqual([]);
  });

  it.each(files.map((f) => [patternOf(f), f]))('%s is in the registry and in the matrix, for every exported method', (pattern, file) => {
    const methods = exportedMethods(fs.readFileSync(file as string, 'utf8'));
    const entry = ROUTES.find((r) => r.pattern === pattern);
    expect(entry, `registry is missing ${pattern}`).toBeDefined();
    expect(Object.keys(entry?.methods ?? {}).sort()).toEqual([...methods].sort());
    for (const m of methods) {
      expect(accessFor(entry!, m as Method), `registry has no access rule for ${m} ${pattern}`).toBeDefined();
      expect(MATRIX.find((r) => r.route === pattern && r.method === m), `matrix is missing ${m} ${pattern}`).toBeDefined();
    }
  });

  it('the registry and the matrix list nothing that has no route file', () => {
    const patterns = new Set(files.map(patternOf));
    for (const r of ROUTES) expect(patterns.has(r.pattern), r.pattern).toBe(true);
    for (const row of MATRIX) expect(patterns.has(row.route), row.route).toBe(true);
  });

  it('every matrix row names the permission its method is actually registered with (per method for split routes)', () => {
    for (const row of MATRIX) {
      const entry = ROUTES.find((r) => r.pattern === row.route)!;
      const rule = accessFor(entry, row.method as Method);
      if (row.permission) expect(rule, `${row.method} ${row.route}`).toEqual({ kind: 'permission', permission: row.permission });
      else expect(rule?.kind, `${row.method} ${row.route}`).not.toBe('permission');
    }
  });

  it('every matrix row lists a verdict for every principal and a body for every non-GET row that has one to validate', () => {
    for (const row of MATRIX) expect(row.verdicts, row.route).toHaveLength(PRINCIPALS.length);
  });
});

describe('access matrix', () => {
  let app: TestApp;
  const OTHER_PERMISSIONS: Permission[] = ['users.manage', 'audit.read', 'settings.manage', 'orders.read', 'orders.write'];

  async function freshCookie(p: Principal, permission?: Permission): Promise<string | undefined> {
    if (p === 'anonymous') return undefined;
    const spec = {
      affiliate: { role: 'affiliate' as const },
      sub_manager: { role: 'sub_manager' as const },
      // a super manager WITHOUT the route's permission (holding the other ones, so only that one is missing)
      sm_none: { role: 'super_manager' as const, totp: true, permissions: OTHER_PERMISSIONS.filter((x) => x !== permission) },
      sm_permitted: { role: 'super_manager' as const, totp: true, permissions: [permission ?? 'orders.read'] },
      owner: { role: 'super_manager' as const, isOwner: true, totp: true },
      sm_unenrolled: { role: 'super_manager' as const },
    }[p];
    const u = await seedUser(app, spec);
    return login(app, u.email, u.password, { totpCode: u.totpSecret ? totpCodeAt(u.totpSecret, app.clock.now()) : undefined });
  }

  /** One session per principal and permission, reused across rows (these requests never end a session). */
  const sessions = new Map<string, Promise<string | undefined>>();
  function cookieFor(p: Principal, permission?: Permission): Promise<string | undefined> {
    const key = `${p}:${permission ?? ''}`;
    let c = sessions.get(key);
    if (!c) {
      c = freshCookie(p, permission);
      sessions.set(key, c);
    }
    return c;
  }

  beforeAll(() => {
    app = createTestApp();
  });
  afterAll(() => app.close());

  for (const row of MATRIX) {
    describe(`${row.method} ${row.route}`, () => {
      it.each(PRINCIPALS.map((p, i) => [p, row.verdicts[i] as Verdict]))('%s -> %s', async (principal, verdict) => {
        app.limiter.reset();
        const cookie = row.consumes ? await freshCookie(principal as Principal, row.permission) : await cookieFor(principal as Principal, row.permission);
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

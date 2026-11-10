import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Permission } from '@darling/shared';
import type { Access } from '../src/plugins/access';
import {
  createTestContext,
  csrfHeaders,
  freshAddress,
  login,
  seedUser,
  totpCodeAt,
  type TestContext,
} from './context';

/**
 * Every route the app registers, captured at registration time: a wrapper around Fastify() adds an
 * onRoute hook before any plugin is loaded, so nothing (not even a route added by a later plugin)
 * can be missed, and the route's declared `config.access` is recorded exactly as registered.
 */
type Registered = { key: string; access: Access | undefined };
const registered = vi.hoisted(() => [] as Registered[]);
vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  const create = actual.default as unknown as (...args: unknown[]) => FastifyInstance;
  const wrapped = ((...args: unknown[]) => {
    const app = create(...args);
    app.addHook('onRoute', (route) => {
      const methods: string[] = ([] as string[]).concat(route.method as string | string[]);
      for (const method of methods) {
        registered.push({ key: `${method} ${route.url}`, access: route.config?.access as Access | undefined });
      }
    });
    return app;
  }) as typeof actual.default;
  return { ...actual, default: wrapped, fastify: wrapped };
});

// ---------------------------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------------------------

/** The route must refuse: exactly this status and body code, even though the request body is empty/invalid. */
type Refuse = { refuse: 401 | 403; code: string };
/** The authorization check passes; the handler answers with one of these (it may legitimately say 400/404 to an empty body or an example id). Never 401/403. */
type Pass = { pass: readonly number[] };
type Expectation = Refuse | Pass;

const UNAUTHENTICATED: Refuse = { refuse: 401, code: 'unauthenticated' };
const FORBIDDEN: Refuse = { refuse: 403, code: 'forbidden' };
const pass = (...statuses: number[]): Pass => ({ pass: statuses });

const PRINCIPALS = ['anonymous', 'affiliate', 'sub_manager', 'superManagerNoPerms', 'superManagerWithPerm', 'owner'] as const;
type PrincipalName = (typeof PRINCIPALS)[number];

type Row = {
  method: 'GET' | 'POST' | 'PATCH';
  /** Concrete URL: route parameters replaced by example values. */
  url: string;
  /** The registered route pattern, as Fastify reports it (`:param` placeholders). */
  pattern: string;
  /** Declared access kind; compared with the route's real `config.access.kind`. */
  accessKind: Access['kind'];
  /** Deliberately empty/invalid where the route has a body, to prove the check runs before validation. */
  body?: unknown;
  expectations: Record<PrincipalName, Expectation>;
};

const EXAMPLE_ID = '00000000-0000-7000-8000-000000000001';

/** Public: the access check never refuses anyone; the handler answers whatever it answers. */
function publicRow(method: Row['method'], pattern: string, url: string, statuses: number[], body?: unknown): Row {
  const expectation = pass(...statuses);
  return {
    method,
    pattern,
    url,
    accessKind: 'public',
    ...(body === undefined ? {} : { body }),
    expectations: {
      anonymous: expectation,
      affiliate: expectation,
      sub_manager: expectation,
      superManagerNoPerms: expectation,
      superManagerWithPerm: expectation,
      owner: expectation,
    },
  };
}

/** Any signed-in user, whatever the role. */
function authenticatedRow(method: Row['method'], pattern: string, url: string, statuses: number[], body?: unknown): Row {
  const expectation = pass(...statuses);
  return {
    method,
    pattern,
    url,
    accessKind: 'authenticated',
    ...(body === undefined ? {} : { body }),
    expectations: {
      anonymous: UNAUTHENTICATED,
      affiliate: expectation,
      sub_manager: expectation,
      superManagerNoPerms: expectation,
      superManagerWithPerm: expectation,
      owner: expectation,
    },
  };
}

/** Needs one permission: only a Super Manager holding it, or the owner (who holds all of them). */
function permissionRow(method: Row['method'], pattern: string, url: string, statuses: number[], body?: unknown): Row {
  const expectation = pass(...statuses);
  return {
    method,
    pattern,
    url,
    accessKind: 'permission',
    ...(body === undefined ? {} : { body }),
    expectations: {
      anonymous: UNAUTHENTICATED,
      affiliate: FORBIDDEN,
      sub_manager: FORBIDDEN,
      superManagerNoPerms: FORBIDDEN,
      superManagerWithPerm: expectation,
      owner: expectation,
    },
  };
}

/** The permission each `permission` route declares: the `superManagerWithPerm` principal for the row holds exactly this one. */
const PERMISSION_OF: Record<string, Permission> = {
  'GET /api/users': 'users.manage',
  'POST /api/users': 'users.manage',
  'GET /api/users/:id': 'users.manage',
  'PATCH /api/users/:id': 'users.manage',
  'POST /api/users/:id/suspend': 'users.manage',
  'POST /api/users/:id/reactivate': 'users.manage',
  'POST /api/users/:id/resend-invite': 'users.manage',
  'POST /api/users/:id/revoke-sessions': 'users.manage',
  'GET /api/audit-log': 'audit.read',
  'GET /api/login-events': 'audit.read',
  'GET /api/settings': 'settings.manage',
  'PATCH /api/settings/:key': 'settings.manage',
};

// `logout` is deliberately the LAST row: it ends the calling principal's session.
export const MATRIX: Row[] = [
  publicRow('GET', '/api/health', '/api/health', [200]),
  publicRow('POST', '/api/auth/login', '/api/auth/login', [400], {}),
  publicRow('GET', '/api/auth/invite/:token', '/api/auth/invite/example-token', [404]),
  publicRow('POST', '/api/auth/invite/accept', '/api/auth/invite/accept', [400], {}),
  publicRow('POST', '/api/auth/password/forgot', '/api/auth/password/forgot', [400], {}),
  publicRow('POST', '/api/auth/password/reset', '/api/auth/password/reset', [400], {}),

  authenticatedRow('GET', '/api/auth/me', '/api/auth/me', [200]),
  // Setup starts enrolment (200) or, when 2FA is already on, says so (409).
  authenticatedRow('POST', '/api/auth/2fa/setup', '/api/auth/2fa/setup', [200, 409]),
  authenticatedRow('POST', '/api/auth/2fa/enable', '/api/auth/2fa/enable', [400], {}),
  authenticatedRow('POST', '/api/auth/2fa/disable', '/api/auth/2fa/disable', [400], {}),
  authenticatedRow('POST', '/api/auth/password/change', '/api/auth/password/change', [400], {}),

  permissionRow('GET', '/api/users', '/api/users', [200]),
  permissionRow('POST', '/api/users', '/api/users', [400], {}),
  permissionRow('GET', '/api/users/:id', `/api/users/${EXAMPLE_ID}`, [404]),
  permissionRow('PATCH', '/api/users/:id', `/api/users/${EXAMPLE_ID}`, [400, 404], {}),
  permissionRow('POST', '/api/users/:id/suspend', `/api/users/${EXAMPLE_ID}/suspend`, [404], {}),
  permissionRow('POST', '/api/users/:id/reactivate', `/api/users/${EXAMPLE_ID}/reactivate`, [404], {}),
  permissionRow('POST', '/api/users/:id/resend-invite', `/api/users/${EXAMPLE_ID}/resend-invite`, [404], {}),
  permissionRow('POST', '/api/users/:id/revoke-sessions', `/api/users/${EXAMPLE_ID}/revoke-sessions`, [404], {}),
  permissionRow('GET', '/api/audit-log', '/api/audit-log', [200]),
  permissionRow('GET', '/api/login-events', '/api/login-events', [200]),
  permissionRow('GET', '/api/settings', '/api/settings', [200]),
  permissionRow('PATCH', '/api/settings/:key', '/api/settings/company.name', [400], {}),

  authenticatedRow('POST', '/api/auth/logout', '/api/auth/logout', [204]),
];

/**
 * What a Super Manager who has NOT enrolled two-factor gets while `security.require_2fa_super_managers`
 * is on (its default): everything is refused with `2fa_enrollment_required` except the routes that
 * declare `allowDuring2faEnrollment` (so they can enrol) and the public ones.
 */
type EnrollmentOutcome = 'blocked' | 'allowed';
export const ENROLLMENT: ReadonlyArray<readonly [key: string, outcome: EnrollmentOutcome]> = [
  ['GET /api/health', 'allowed'],
  ['POST /api/auth/login', 'allowed'],
  ['GET /api/auth/invite/:token', 'allowed'],
  ['POST /api/auth/invite/accept', 'allowed'],
  ['POST /api/auth/password/forgot', 'allowed'],
  ['POST /api/auth/password/reset', 'allowed'],
  ['GET /api/auth/me', 'allowed'],
  ['POST /api/auth/2fa/setup', 'allowed'],
  ['POST /api/auth/2fa/enable', 'allowed'],
  ['POST /api/auth/2fa/disable', 'allowed'],
  ['POST /api/auth/password/change', 'allowed'],
  ['GET /api/users', 'blocked'],
  ['POST /api/users', 'blocked'],
  ['GET /api/users/:id', 'blocked'],
  ['PATCH /api/users/:id', 'blocked'],
  ['POST /api/users/:id/suspend', 'blocked'],
  ['POST /api/users/:id/reactivate', 'blocked'],
  ['POST /api/users/:id/resend-invite', 'blocked'],
  ['POST /api/users/:id/revoke-sessions', 'blocked'],
  ['GET /api/audit-log', 'blocked'],
  ['GET /api/login-events', 'blocked'],
  ['GET /api/settings', 'blocked'],
  ['PATCH /api/settings/:key', 'blocked'],
  ['POST /api/auth/logout', 'allowed'], // last: it ends the session
];

// ---------------------------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------------------------

/** Auto-generated HEAD twins of GET routes carry the GET route's rule and are not separate routes. */
const isAutoHead = (key: string) => key.startsWith('HEAD ');

/** Names every registered route missing from a table, and every table row naming no registered route. */
export function routeDifferences(registeredKeys: readonly string[], tableKeys: readonly string[]) {
  const real = new Set(registeredKeys.filter((key) => !isAutoHead(key)));
  const listed = new Set(tableKeys);
  return {
    missing: [...real].filter((key) => !listed.has(key)).sort(),
    stale: [...listed].filter((key) => !real.has(key)).sort(),
  };
}

function describeDifferences(table: string, diff: { missing: string[]; stale: string[] }): string {
  return [
    diff.missing.length ? `${table}: registered routes missing from the table: ${diff.missing.join(', ')}` : '',
    diff.stale.length ? `${table}: table rows for routes that are not registered (stale): ${diff.stale.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const rowKey = (row: Row) => `${row.method} ${row.pattern}`;

describe('routeDifferences', () => {
  it('names a registered route that has no row and a row that has no route', () => {
    const diff = routeDifferences(['GET /a', 'HEAD /a', 'POST /b'], ['GET /a', 'GET /gone']);
    expect(diff).toEqual({ missing: ['POST /b'], stale: ['GET /gone'] });
    expect(describeDifferences('matrix', diff)).toContain('POST /b');
    expect(describeDifferences('matrix', diff)).toContain('GET /gone');
  });
});

// ---------------------------------------------------------------------------------------------
// Driving the real app
// ---------------------------------------------------------------------------------------------

let ctx: TestContext;
const cookies: Partial<Record<string, string>> = {};
let enrollmentCookie = '';

async function seedAndLogin(name: string, input: Parameters<typeof seedUser>[1]): Promise<void> {
  const user = await seedUser(ctx, { ...input, totp: input.totp ?? false });
  const code = user.totpSecret ? totpCodeAt(user.totpSecret, ctx.clock.now) : undefined;
  cookies[name] = await login(ctx, user.email, user.password, code);
}

beforeAll(async () => {
  ctx = await createTestContext();
  // One principal each, logged in once. Super Managers have 2FA enabled so `mustEnroll2fa` is false.
  await seedAndLogin('affiliate', { role: 'affiliate' });
  await seedAndLogin('sub_manager', { role: 'sub_manager' });
  await seedAndLogin('superManagerNoPerms', { role: 'super_manager', totp: true });
  // The `superManagerWithPerm` stand-in on rows with no permission rule: same shape as `superManagerNoPerms`,
  // but its own session, because `logout` ends the session it uses.
  await seedAndLogin('superManagerDefault', { role: 'super_manager', totp: true });
  // `superManagerWithPerm`: a Super Manager holding exactly the permission the row's route declares.
  await seedAndLogin('perm:users.manage', { role: 'super_manager', totp: true, permissions: ['users.manage'] });
  await seedAndLogin('perm:audit.read', { role: 'super_manager', totp: true, permissions: ['audit.read'] });
  await seedAndLogin('perm:settings.manage', { role: 'super_manager', totp: true, permissions: ['settings.manage'] });
  await seedAndLogin('owner', { role: 'super_manager', isOwner: true, totp: true });
  // A Super Manager without 2FA, for the enrolment table (the setting defaults to on).
  await seedAndLogin('noTotp', { role: 'super_manager' });
  enrollmentCookie = cookies['noTotp'] as string;
}, 120_000);

afterAll(async () => {
  await ctx.close();
});

/** Which session a principal uses on a given row. */
function cookieFor(principal: PrincipalName, row: Row): string | undefined {
  switch (principal) {
    case 'anonymous':
      return undefined;
    case 'superManagerWithPerm': {
      const permission = PERMISSION_OF[rowKey(row)];
      // Rows whose rule is not `permission` use the same Super Manager with no extra permission.
      return permission ? cookies[`perm:${permission}`] : cookies['superManagerDefault'];
    }
    default:
      return cookies[principal];
  }
}

function send(row: Row, cookie: string | undefined): Promise<LightMyRequestResponse> {
  return ctx.app.inject({
    method: row.method,
    url: row.url,
    // Real CSRF headers on every request, so a refusal can only come from the access check.
    headers: { ...csrfHeaders(ctx), ...(cookie ? { cookie } : {}) },
    // A distinct client address per request keeps the per-IP limiters out of the way.
    remoteAddress: freshAddress(),
    ...(row.body === undefined ? {} : { payload: row.body as object }),
  });
}

function bodyCode(res: LightMyRequestResponse): unknown {
  try {
    return (res.json() as { code?: unknown }).code;
  } catch {
    return undefined;
  }
}

describe('route registry', () => {
  it('lists every registered route, and nothing else (matrix)', () => {
    const diff = routeDifferences(registered.map((r) => r.key), MATRIX.map(rowKey));
    expect(diff.missing.length + diff.stale.length, describeDifferences('matrix', diff)).toBe(0);
  });

  it('lists every registered route, and nothing else (2FA enrolment table)', () => {
    const diff = routeDifferences(registered.map((r) => r.key), ENROLLMENT.map(([key]) => key));
    expect(diff.missing.length + diff.stale.length, describeDifferences('enrolment', diff)).toBe(0);
  });

  it('has no duplicate rows', () => {
    expect(new Set(MATRIX.map(rowKey)).size).toBe(MATRIX.length);
    expect(new Set(ENROLLMENT.map(([key]) => key)).size).toBe(ENROLLMENT.length);
  });

  it('declares the access kind the route really has', () => {
    for (const row of MATRIX) {
      const route = registered.find((r) => r.key === rowKey(row));
      expect(route?.access?.kind, `${rowKey(row)}: declared access kind`).toBe(row.accessKind);
    }
  });

  it('names the permission each permission route really requires', () => {
    for (const row of MATRIX.filter((r) => r.accessKind === 'permission')) {
      const route = registered.find((r) => r.key === rowKey(row));
      const access = route?.access;
      expect(access?.kind === 'permission' ? access.permission : undefined, rowKey(row)).toBe(PERMISSION_OF[rowKey(row)]);
    }
  });

  it('keeps the enrolment table in step with the declared rules', () => {
    for (const [key, outcome] of ENROLLMENT) {
      const access = registered.find((r) => r.key === key)?.access;
      const exempt = access?.kind === 'public' || (access?.kind === 'authenticated' && access.allowDuring2faEnrollment === true);
      expect(outcome, key).toBe(exempt ? 'allowed' : 'blocked');
    }
  });
});

describe('authorization matrix', () => {
  // Rows run in table order within each principal, so `logout` (last) ends a session only after
  // every other row used it.
  for (const principal of PRINCIPALS) {
    it(`${principal}: gets the expected outcome on every route`, async () => {
      const failures: string[] = [];
      for (const row of MATRIX) {
        const expected = row.expectations[principal];
        const res = await send(row, cookieFor(principal, row));
        const label = `${principal} ${row.method} ${row.url}`;
        if ('refuse' in expected) {
          if (res.statusCode !== expected.refuse || bodyCode(res) !== expected.code) {
            failures.push(`${label}: expected ${expected.refuse} ${expected.code}, got ${res.statusCode} ${res.body}`);
          }
        } else if (res.statusCode === 401 || res.statusCode === 403 || !expected.pass.includes(res.statusCode)) {
          failures.push(`${label}: expected one of [${expected.pass.join(', ')}], got ${res.statusCode} ${res.body}`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});

describe('2FA enrolment required', () => {
  it('blocks everything but the enrolment routes and the public routes for a Super Manager without 2FA', async () => {
    const failures: string[] = [];
    for (const [key, outcome] of ENROLLMENT) {
      const row = MATRIX.find((r) => rowKey(r) === key) as Row;
      const res = await send(row, enrollmentCookie);
      const blocked = res.statusCode === 403 && bodyCode(res) === '2fa_enrollment_required';
      if (outcome === 'blocked' && !(blocked && JSON.stringify(res.json()) === '{"code":"2fa_enrollment_required"}')) {
        failures.push(`${key}: expected 403 2fa_enrollment_required, got ${res.statusCode} ${res.body}`);
      }
      if (outcome === 'allowed' && (blocked || res.statusCode === 401)) {
        failures.push(`${key}: expected to be allowed during enrolment, got ${res.statusCode} ${res.body}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

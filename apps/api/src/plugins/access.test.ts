import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERMISSIONS, type Permission, type Role } from '@darling/shared';
import { buildApp } from '../app';
import { testDeps } from '../test-helpers';
import type { Access, AuthContext } from './access';

type PrincipalName =
  | 'anonymous'
  | 'affiliate'
  | 'sub_manager'
  | 'sub_manager_with_stray_permission'
  | 'super_manager_without_permission'
  | 'super_manager_with_permission'
  | 'owner'
  | 'enrolling_super_manager'
  | 'enrolling_owner'
  | 'enrolling_affiliate';

function auth(
  role: Role,
  opts: { permissions?: Permission[]; isOwner?: boolean; mustEnroll2fa?: boolean } = {},
): AuthContext {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    role,
    isOwner: opts.isOwner ?? false,
    permissions: new Set(opts.permissions ?? []),
    mustEnroll2fa: opts.mustEnroll2fa ?? false,
  };
}

const PRINCIPALS: Record<PrincipalName, AuthContext | null> = {
  anonymous: null,
  affiliate: auth('affiliate'),
  sub_manager: auth('sub_manager'),
  sub_manager_with_stray_permission: auth('sub_manager', { permissions: ['orders.read'] }),
  super_manager_without_permission: auth('super_manager', { permissions: ['orders.write'] }),
  super_manager_with_permission: auth('super_manager', { permissions: ['orders.read'] }),
  owner: auth('super_manager', { isOwner: true, permissions: [...PERMISSIONS] }),
  enrolling_super_manager: auth('super_manager', {
    mustEnroll2fa: true,
    permissions: ['orders.read'],
  }),
  enrolling_owner: auth('super_manager', {
    isOwner: true,
    mustEnroll2fa: true,
    permissions: [...PERMISSIONS],
  }),
  enrolling_affiliate: auth('affiliate', { mustEnroll2fa: true }),
};

const PRINCIPAL_HEADER = 'x-test-principal';

/** The real app plus probe routes; request.auth comes from a test-only onRequest hook. */
async function probeApp(routes: Record<string, Access>): Promise<FastifyInstance> {
  const app = await buildApp(testDeps(), {
    extend: (instance) => {
      instance.addHook('onRequest', async (req) => {
        const name = req.headers[PRINCIPAL_HEADER];
        req.auth = typeof name === 'string' ? (PRINCIPALS[name as PrincipalName] ?? null) : null;
      });
      for (const [path, access] of Object.entries(routes)) {
        instance.get(path, { config: { access } }, async () => ({ reached: path }));
      }
    },
  });
  await app.ready();
  return app;
}

type Expected = 200 | 401 | 403;
type Row = [PrincipalName, Expected, string?];

const ENROLL = '2fa_enrollment_required';
const NO_SESSION = 'unauthenticated';
const FORBIDDEN = 'forbidden';

const MATRIX: Array<{ name: string; access: Access; rows: Row[] }> = [
  {
    name: 'public',
    access: { kind: 'public' },
    rows: [
      ['anonymous', 200],
      ['affiliate', 200],
      ['sub_manager', 200],
      ['super_manager_without_permission', 200],
      ['super_manager_with_permission', 200],
      ['owner', 200],
      ['enrolling_super_manager', 200],
    ],
  },
  {
    name: 'authenticated',
    access: { kind: 'authenticated' },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 200],
      ['sub_manager', 200],
      ['super_manager_without_permission', 200],
      ['super_manager_with_permission', 200],
      ['owner', 200],
      ['enrolling_super_manager', 403, ENROLL],
      ['enrolling_owner', 403, ENROLL],
      ['enrolling_affiliate', 403, ENROLL],
    ],
  },
  {
    name: 'authenticated, allowDuring2faEnrollment: false',
    access: { kind: 'authenticated', allowDuring2faEnrollment: false },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 200],
      ['owner', 200],
      ['enrolling_super_manager', 403, ENROLL],
      ['enrolling_owner', 403, ENROLL],
      ['enrolling_affiliate', 403, ENROLL],
    ],
  },
  {
    name: 'authenticated, allowDuring2faEnrollment: true',
    access: { kind: 'authenticated', allowDuring2faEnrollment: true },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 200],
      ['sub_manager', 200],
      ['super_manager_without_permission', 200],
      ['super_manager_with_permission', 200],
      ['owner', 200],
      ['enrolling_super_manager', 200],
      ['enrolling_owner', 200],
      ['enrolling_affiliate', 200],
    ],
  },
  {
    name: 'role [affiliate]',
    access: { kind: 'role', roles: ['affiliate'] },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 200],
      ['sub_manager', 403, FORBIDDEN],
      ['super_manager_without_permission', 403, FORBIDDEN],
      ['super_manager_with_permission', 403, FORBIDDEN],
      ['owner', 403, FORBIDDEN],
      ['enrolling_affiliate', 403, ENROLL],
    ],
  },
  {
    name: 'role [sub_manager]',
    access: { kind: 'role', roles: ['sub_manager'] },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 403, FORBIDDEN],
      ['sub_manager', 200],
      ['super_manager_without_permission', 403, FORBIDDEN],
      ['super_manager_with_permission', 403, FORBIDDEN],
      ['owner', 403, FORBIDDEN],
    ],
  },
  {
    name: 'role [sub_manager, super_manager]',
    access: { kind: 'role', roles: ['sub_manager', 'super_manager'] },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 403, FORBIDDEN],
      ['sub_manager', 200],
      ['super_manager_without_permission', 200],
      ['super_manager_with_permission', 200],
      ['owner', 200],
      ['enrolling_super_manager', 403, ENROLL],
      ['enrolling_owner', 403, ENROLL],
    ],
  },
  {
    name: 'role [] (nobody)',
    access: { kind: 'role', roles: [] },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 403, FORBIDDEN],
      ['owner', 403, FORBIDDEN],
    ],
  },
  {
    name: 'permission orders.read',
    access: { kind: 'permission', permission: 'orders.read' },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 403, FORBIDDEN],
      ['sub_manager', 403, FORBIDDEN],
      ['sub_manager_with_stray_permission', 403, FORBIDDEN],
      ['super_manager_without_permission', 403, FORBIDDEN],
      ['super_manager_with_permission', 200],
      ['owner', 200],
      ['enrolling_super_manager', 403, ENROLL],
      ['enrolling_owner', 403, ENROLL],
    ],
  },
  {
    name: 'owner',
    access: { kind: 'owner' },
    rows: [
      ['anonymous', 401, NO_SESSION],
      ['affiliate', 403, FORBIDDEN],
      ['sub_manager', 403, FORBIDDEN],
      ['sub_manager_with_stray_permission', 403, FORBIDDEN],
      ['super_manager_without_permission', 403, FORBIDDEN],
      ['super_manager_with_permission', 403, FORBIDDEN],
      ['owner', 200],
      ['enrolling_owner', 403, ENROLL],
    ],
  },
];

describe('access plugin enforcement matrix', () => {
  const cases = MATRIX.flatMap(({ name, access, rows }, i) =>
    rows.map(([principal, status, code]) => ({ name, access, path: `/probe/${i}`, principal, status, code })),
  );

  it.each(cases)('$name / $principal -> $status', async ({ access, path, principal, status, code }) => {
    const app = await probeApp({ [path]: access });
    try {
      const res = await app.inject({
        method: 'GET',
        url: path,
        headers: principal === 'anonymous' ? {} : { [PRINCIPAL_HEADER]: principal },
      });
      expect(res.statusCode).toBe(status);
      if (status === 200) {
        expect(res.json()).toEqual({ reached: path });
      } else {
        // A refused request never reaches the handler, so it can never carry data.
        expect(res.json()).toEqual({ code });
      }
    } finally {
      await app.close();
    }
  });

  it('covers every Access kind and all six principals', () => {
    const kinds = new Set(MATRIX.map((m) => m.access.kind));
    expect([...kinds].sort()).toEqual(['authenticated', 'owner', 'permission', 'public', 'role']);
    const principals = new Set(MATRIX.flatMap((m) => m.rows.map((r) => r[0])));
    for (const p of [
      'anonymous',
      'affiliate',
      'sub_manager',
      'super_manager_without_permission',
      'super_manager_with_permission',
      'owner',
    ] as const) {
      expect(principals.has(p)).toBe(true);
    }
  });
});

describe('access plugin wiring', () => {
  it('never runs the handler for a refused request', async () => {
    let calls = 0;
    const app = await buildApp(testDeps(), {
      extend: (instance) => {
        instance.get('/secret', { config: { access: { kind: 'owner' } } }, async () => {
          calls += 1;
          return { secret: true };
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/secret' });
    expect(res.statusCode).toBe(401);
    expect(calls).toBe(0);
    await app.close();
  });

  it('applies to routes registered in encapsulated child plugins too', async () => {
    const app = await buildApp(testDeps(), {
      extend: (instance) => {
        instance.register(async (child) => {
          child.get('/nested', { config: { access: { kind: 'authenticated' } } }, async () => ({ ok: true }));
        });
      },
    });
    expect((await app.inject({ method: 'GET', url: '/nested' })).statusCode).toBe(401);
    await app.close();
  });

  it('rejects a route without an access rule: buildApp fails with "no access rule"', async () => {
    await expect(
      buildApp(testDeps(), {
        extend: (instance) => {
          instance.get('/oops', async () => ({ ok: true }));
        },
      }),
    ).rejects.toThrow('Route GET /oops has no access rule');
  });

  it('rejects an access-less route in an encapsulated plugin and for every method', async () => {
    await expect(
      buildApp(testDeps(), {
        extend: (instance) => {
          instance.register(async (child) => {
            child.post('/child', async () => ({ ok: true }));
          });
        },
      }),
    ).rejects.toThrow('Route POST /child has no access rule');
    await expect(
      buildApp(testDeps(), {
        extend: (instance) => {
          instance.route({ method: ['GET', 'DELETE'], url: '/multi', handler: async () => ({}) });
        },
      }),
    ).rejects.toThrow(/Route .*\/multi has no access rule/);
  });

  it('rejects a route whose config exists but has no access', async () => {
    await expect(
      buildApp(testDeps(), {
        extend: (instance) => {
          instance.get('/cfg', { config: {} }, async () => ({}));
        },
      }),
    ).rejects.toThrow('Route GET /cfg has no access rule');
  });

  it('keeps Fastify own routes working: auto HEAD, unknown paths, and the health route', async () => {
    const app = await buildApp(testDeps(), {
      extend: (instance) => {
        instance.get('/pub', { config: { access: { kind: 'public' } } }, async () => ({ ok: true }));
      },
    });
    const head = await app.inject({ method: 'HEAD', url: '/pub' });
    expect(head.statusCode).toBe(200);
    const unknown = await app.inject({ method: 'GET', url: '/no/such/route' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: 'not_found' });
    const unknownPost = await app.inject({
      method: 'POST',
      url: '/no/such/route',
      headers: { 'x-requested-with': 'fetch', origin: 'http://localhost:3000' },
    });
    expect(unknownPost.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('an auto HEAD route is as protected as its GET route', async () => {
    const app = await buildApp(testDeps(), {
      extend: (instance) => {
        instance.get('/locked', { config: { access: { kind: 'authenticated' } } }, async () => ({ ok: true }));
      },
    });
    const head = await app.inject({ method: 'HEAD', url: '/locked' });
    expect(head.statusCode).toBe(401);
    await app.close();
  });

  it('declares request.auth as null until an auth plugin sets it', async () => {
    let seen: unknown = 'unset';
    const app = await buildApp(testDeps(), {
      extend: (instance) => {
        instance.get('/who', { config: { access: { kind: 'public' } } }, async (req) => {
          seen = req.auth;
          return {};
        });
      },
    });
    await app.inject({ method: 'GET', url: '/who' });
    expect(seen).toBeNull();
    await app.close();
  });
});

describe('access is enforced before body validation', () => {
  const CSRF = { 'x-requested-with': 'fetch', origin: 'http://localhost:3000' };
  const INVALID = { notTheField: 1 };

  type Counters = { refine: number; preValidation: number; handler: number };

  /** Protected POST routes whose body schema has a secret field name, a refine and a route-level hook. */
  async function schemaApp(access: Access): Promise<{ app: FastifyInstance; counters: Counters }> {
    const counters: Counters = { refine: 0, preValidation: 0, handler: 0 };
    const body = z
      .object({ secretField: z.string({ error: 'internal rule xyz' }) })
      .refine(() => {
        counters.refine += 1;
        return true;
      });
    const app = await buildApp(testDeps(), {
      extend: (instance) => {
        instance.addHook('onRequest', async (req) => {
          const name = req.headers[PRINCIPAL_HEADER];
          req.auth = typeof name === 'string' ? (PRINCIPALS[name as PrincipalName] ?? null) : null;
        });
        instance.post(
          '/guarded',
          {
            config: { access },
            schema: { body },
            preValidation: async () => {
              counters.preValidation += 1;
            },
          },
          async () => {
            counters.handler += 1;
            return { ok: true };
          },
        );
      },
    });
    await app.ready();
    return { app, counters };
  }

  const PROTECTED: Array<[string, Access, PrincipalName]> = [
    ['owner', { kind: 'owner' }, 'affiliate'],
    ['permission', { kind: 'permission', permission: 'orders.read' }, 'sub_manager'],
    ['role', { kind: 'role', roles: ['super_manager'] }, 'affiliate'],
  ];

  it.each(PROTECTED)('anonymous + invalid body on a %s route -> 401, no field names', async (_n, access) => {
    const { app } = await schemaApp(access);
    const res = await app.inject({ method: 'POST', url: '/guarded', headers: CSRF, payload: INVALID });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthenticated' });
    expect(res.body).not.toContain('secretField');
    expect(res.body).not.toContain('internal rule xyz');
    await app.close();
  });

  it.each(PROTECTED)(
    'forbidden caller + invalid body on a %s route -> 403, not 400',
    async (_n, access, principal) => {
      const { app } = await schemaApp(access);
      const res = await app.inject({
        method: 'POST',
        url: '/guarded',
        headers: { ...CSRF, [PRINCIPAL_HEADER]: principal },
        payload: INVALID,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: 'forbidden' });
      expect(res.body).not.toContain('secretField');
      await app.close();
    },
  );

  it('a refused request never runs the schema refine, a route-level preValidation hook or the handler', async () => {
    const { app, counters } = await schemaApp({ kind: 'owner' });
    for (const principal of [undefined, 'affiliate', 'super_manager_with_permission'] as const) {
      await app.inject({
        method: 'POST',
        url: '/guarded',
        headers: principal ? { ...CSRF, [PRINCIPAL_HEADER]: principal } : CSRF,
        payload: { secretField: 'valid' },
      });
    }
    expect(counters).toEqual({ refine: 0, preValidation: 0, handler: 0 });
    // The counters are live: an authorised caller does run them.
    const ok = await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { ...CSRF, [PRINCIPAL_HEADER]: 'owner' },
      payload: { secretField: 'valid' },
    });
    expect(ok.statusCode).toBe(200);
    expect(counters.refine).toBe(1);
    expect(counters.preValidation).toBe(1);
    expect(counters.handler).toBe(1);
    await app.close();
  });

  it('a public route with an invalid body still returns the normal 400 validation error', async () => {
    const { app } = await schemaApp({ kind: 'public' });
    const res = await app.inject({ method: 'POST', url: '/guarded', headers: CSRF, payload: INVALID });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation' });
    await app.close();
  });

  it('an authorised caller with an invalid body still gets 400', async () => {
    const { app, counters } = await schemaApp({ kind: 'owner' });
    const res = await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { ...CSRF, [PRINCIPAL_HEADER]: 'owner' },
      payload: INVALID,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation' });
    expect(counters.handler).toBe(0);
    await app.close();
  });
});

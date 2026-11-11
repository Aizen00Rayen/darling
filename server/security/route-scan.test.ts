import { describe, expect, it } from 'vitest';
import { accessProblems, exportedMethods, perMethodAccessKeys } from './route-scan';

const SINGLE = `
export const access = { kind: 'permission', permission: 'users.manage' } as const;
export const GET = withAccess(access, () => json(200, {}));
export const POST = withAccess<typeof access, { id: string }>(access, userAction(x));
`;

const PER_METHOD = `
export const access = {
  POST: { kind: 'public' },
  GET: { kind: 'permission', permission: 'orders.read' },
} as const;
export const POST = withAccess(access.POST, async () => json(200, {}));
export const GET = withAccess<typeof access.GET>(access.GET, async () => json(200, {}));
`;

describe('exportedMethods', () => {
  it('finds const, function and async function exports', () => {
    expect(exportedMethods('export const GET = a; export async function POST() {} export function DELETE() {}')).toEqual(['GET', 'POST', 'DELETE']);
    expect(exportedMethods('const GET = 1; function POST() {}')).toEqual([]);
  });
});

describe('perMethodAccessKeys', () => {
  it('is null for one rule for the whole route', () => {
    expect(perMethodAccessKeys(SINGLE)).toBeNull();
  });
  it('lists the keys of a per-method access', () => {
    expect(perMethodAccessKeys(PER_METHOD)).toEqual(['GET', 'POST']);
  });
  it('is null when there is no access literal', () => {
    expect(perMethodAccessKeys('export const GET = 1')).toBeNull();
    expect(perMethodAccessKeys('export const access = rules;')).toBeNull();
  });
  it('does not mistake a nested key for a method', () => {
    expect(perMethodAccessKeys("export const access = { kind: 'permission', permission: 'POST: x' } as const;")).toBeNull();
  });
});

describe('accessProblems', () => {
  it('accepts a single rule and per-method rules', () => {
    expect(accessProblems(SINGLE)).toEqual([]);
    expect(accessProblems(PER_METHOD)).toEqual([]);
  });

  it('flags a missing access export and a route without handlers', () => {
    expect(accessProblems('export const GET = withAccess(access, h);')).toContain('does not export `access`');
    expect(accessProblems("export const access = { kind: 'public' } as const;")).toContain('exports no HTTP method handler');
  });

  it('flags a handler that is not built with withAccess, or is a bare function', () => {
    expect(accessProblems(`export const access = { kind: 'public' } as const;\nexport const GET = async () => json(200, {});`)).toContain(
      'GET must be built with withAccess(access, ...)',
    );
    const bare = accessProblems(`export const access = { kind: 'public' } as const;\nexport async function GET() { return json(200, {}); }`);
    expect(bare).toContain('GET must not be a bare function');
  });

  it('flags a per-method handler that uses the wrong entry or the whole object', () => {
    const wrongEntry = PER_METHOD.replace('withAccess(access.POST,', 'withAccess(access.GET,');
    expect(accessProblems(wrongEntry)).toContain('POST must be built with withAccess(access.POST, ...)');
    const whole = PER_METHOD.replace('withAccess(access.POST,', 'withAccess(access,');
    expect(accessProblems(whole)).toContain('POST must be built with withAccess(access.POST, ...)');
  });

  it('flags a single-rule handler that picks a property', () => {
    expect(accessProblems(SINGLE.replace('withAccess(access, () =>', 'withAccess(access.GET, () =>'))).toContain('GET must be built with withAccess(access, ...)');
  });

  it('flags a method without its own rule, and a rule for a method the route does not export', () => {
    const missing = PER_METHOD + '\nexport const PATCH = withAccess(access.PATCH, h);';
    expect(accessProblems(missing)).toContain('PATCH has no entry in the per-method `access`');
    const extra = PER_METHOD.replace('} as const;', "  DELETE: { kind: 'owner' },\n} as const;");
    expect(accessProblems(extra)).toContain('`access` has an entry for DELETE, which the route does not export');
  });
});

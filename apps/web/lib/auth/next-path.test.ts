import { describe, expect, it } from 'vitest';
import { safeNextPath } from './next-path';

const FALLBACK = '/admin';

describe('safeNextPath', () => {
  it.each(['/admin', '/admin/utilisateurs?role=affiliate', '/compte/securite?setup=1', '/manager/commandes#top', '/affiliate'])(
    'accepts the same-site path %s',
    (p) => expect(safeNextPath(p, FALLBACK)).toBe(p),
  );

  it.each([
    ['//evil.com', 'protocol-relative'],
    ['///evil.com', 'triple slash'],
    ['/\\evil.com', 'backslash'],
    ['/\\/evil.com', 'backslash then slash'],
    ['https://evil.com', 'absolute URL'],
    ['http://evil.com/admin', 'absolute http URL'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['data:text/html,x', 'data scheme'],
    ['admin', 'no leading slash'],
    ['/\t/evil.com', 'tab smuggling'],
    ['/\n/evil.com', 'newline'],
    ['/admin\r\nSet-Cookie: x=1', 'CRLF'],
    ['/admin\u0000', 'NUL'],
    ['%2F%2Fevil.com', 'encoded leading slashes'],
    ['/%2F/evil.com', 'encoded second slash'],
    ['/%2f%2fevil.com', 'encoded lowercase'],
    ['/%5Cevil.com', 'encoded backslash'],
    ['/%5cevil.com', 'encoded backslash lowercase'],
    ['/%09/evil.com', 'encoded tab'],
    ['/%0d%0a/evil.com', 'encoded CRLF'],
    ['/%E0%A4%A', 'malformed percent-encoding'],
    ['/%', 'lone percent'],
    ['/..//evil.com', 'dot-dot segment leading to //'],
    ['/admin/../..//evil.com', 'dot-dot segments leading to //'],
    ['/%2e%2e//evil.com', 'encoded dot-dot leading to //'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['/connexion', 'login page itself'],
    ['/connexion?next=/admin', 'login page with query'],
    ['/connexion/', 'login page trailing slash'],
    ['/api/auth/me', 'API path'],
    ['/api', 'bare API path'],
    ['/API/auth/me', 'API path (case)'],
    ['/' + 'a'.repeat(600), 'too long'],
  ])('rejects %s (%s)', (input) => expect(safeNextPath(input, FALLBACK)).toBe(FALLBACK));

  it('rejects null and undefined', () => {
    expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeNextPath(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('accepts a path of exactly 512 characters and rejects 513', () => {
    const ok = '/' + 'a'.repeat(511);
    expect(safeNextPath(ok, FALLBACK)).toBe(ok);
    expect(safeNextPath(ok + 'a', FALLBACK)).toBe(FALLBACK);
  });

  it('keeps a legitimately encoded query value', () => {
    expect(safeNextPath('/admin/utilisateurs?q=a%20b', FALLBACK)).toBe('/admin/utilisateurs?q=a%20b');
  });

  it('allows paths that merely start with login/api-like words', () => {
    expect(safeNextPath('/connexion-help', FALLBACK)).toBe('/connexion-help');
    expect(safeNextPath('/apiary', FALLBACK)).toBe('/apiary');
  });
});

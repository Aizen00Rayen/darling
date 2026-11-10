import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from './proxy';

function req(path: string, cookie?: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), cookie ? { headers: { cookie } } : undefined);
}

describe('proxy()', () => {
  it('matches only the portal areas', () => {
    expect(config.matcher).toEqual(['/admin/:path*', '/manager/:path*', '/affiliate/:path*', '/compte/:path*']);
  });

  it('redirects to the login page with an encoded safe next when there is no session cookie', () => {
    const res = proxy(req('/admin/utilisateurs?role=affiliate'));
    expect([307, 308]).toContain(res.status);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/connexion');
    expect(location.search).toBe('?next=%2Fadmin%2Futilisateurs%3Frole%3Daffiliate');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['dl_session', '__Host-dl_session'])('passes through with no-store when %s is present', (name) => {
    const res = proxy(req('/admin', `${name}=abc`));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('ignores unrelated cookies', () => {
    const res = proxy(req('/compte', 'other=1'));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/connexion');
  });

  it.each(['//evil.com/x', '/api/x', '/admin/../..//evil.com'])('redirects to /connexion without next for the unsafe path %s', (path) => {
    // Build the request URL by hand so the path is not normalised away by URL parsing.
    const request = req('/admin');
    Object.defineProperty(request.nextUrl, 'pathname', { value: path });
    const res = proxy(request);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/connexion');
    expect(location.search).toBe('');
  });
});

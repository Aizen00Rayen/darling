import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/shared';

const loadMe = vi.fn();
const headerValues = new Map<string, string>();
const cookieHeader = { value: 'dl_session=abc' };

// getMe() calls the principal loader in-process (no HTTP): mock the loader and the request cookies.
vi.mock('@/server/auth/principal', () => ({ loadMeFromCookie: (...args: unknown[]) => loadMe(...args) }));
vi.mock('@/server/context', () => ({ getServerContext: () => ({ marker: 'ctx' }) }));
vi.mock('@/server/log', () => ({ logError: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerValues.get(k) ?? null }),
  cookies: async () => ({ toString: () => cookieHeader.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { getMe, requireUser } from './session';

const me = (over: Partial<Me> = {}): Me => ({
  id: 'u1',
  email: 'a@b.co',
  fullName: 'Ada',
  role: 'affiliate',
  isOwner: false,
  permissions: [],
  twoFactorEnabled: true,
  mustEnroll2fa: false,
  ...over,
});

beforeEach(() => {
  loadMe.mockReset();
  cookieHeader.value = 'dl_session=abc';
  headerValues.clear();
});

describe('getMe', () => {
  it('returns the user the loader found, passing the request cookies and the server context', async () => {
    loadMe.mockReturnValue(me());
    expect(await getMe()).toEqual(me());
    expect(loadMe).toHaveBeenCalledWith({ marker: 'ctx' }, 'dl_session=abc');
  });

  it.each([
    ['no session', () => loadMe.mockReturnValue(null)],
    ['database down', () => loadMe.mockImplementation(() => { throw new Error('down'); })],
    ['malformed loader result', () => loadMe.mockReturnValue({ id: 'u1', role: 'root' })],
    ['empty loader result', () => loadMe.mockReturnValue(undefined)],
  ])('returns null on %s', async (_n, arrange) => {
    arrange();
    expect(await getMe()).toBeNull();
  });
});

describe('requireUser', () => {
  it('redirects to login with the encoded safe path when there is no session', async () => {
    loadMe.mockReturnValue(null);
    headerValues.set('x-dl-path', '/admin/utilisateurs?role=affiliate');
    await expect(requireUser(['super_manager'])).rejects.toThrow(
      'REDIRECT:/connexion?next=%2Fadmin%2Futilisateurs%3Frole%3Daffiliate',
    );
  });

  it.each([
    ['database down', () => loadMe.mockImplementation(() => { throw new Error('down'); })],
    ['malformed loader result', () => loadMe.mockReturnValue({ nope: true })],
  ])('treats %s as no session and never returns a user', async (_n, arrange) => {
    arrange();
    headerValues.set('x-dl-path', '/admin');
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/connexion?next=%2Fadmin');
  });

  it.each(['//evil.com', '/api/auth/me', 'https://evil.com', '/connexion'])('ignores a spoofed x-dl-path %s', async (value) => {
    loadMe.mockReturnValue(null);
    headerValues.set('x-dl-path', value);
    await expect(requireUser(['affiliate'])).rejects.toThrow('REDIRECT:/connexion');
    await expect(requireUser(['affiliate'])).rejects.not.toThrow('next=');
  });

  it('redirects to login without next when the header is absent', async () => {
    loadMe.mockReturnValue(null);
    await expect(requireUser(['affiliate'])).rejects.toThrow(/^REDIRECT:\/connexion$/);
  });

  it('redirects a wrong role to its own home', async () => {
    loadMe.mockReturnValue(me({ role: 'affiliate' }));
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/affiliate');
    loadMe.mockReturnValue(me({ role: 'sub_manager' }));
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/manager');
  });

  it('redirects to 2FA enrolment when required', async () => {
    loadMe.mockReturnValue(me({ role: 'super_manager', mustEnroll2fa: true }));
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/compte/securite?setup=1');
  });

  it('does not redirect during enrolment when allowDuring2faEnrollment is set', async () => {
    const user = me({ role: 'super_manager', mustEnroll2fa: true });
    loadMe.mockReturnValue(user);
    expect(await requireUser(['super_manager'], { allowDuring2faEnrollment: true })).toEqual(user);
  });

  it('returns the user for an allowed role', async () => {
    loadMe.mockReturnValue(me());
    expect(await requireUser(['affiliate', 'sub_manager'])).toEqual(me());
  });
});

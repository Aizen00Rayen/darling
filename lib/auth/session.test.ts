import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/shared';

const apiServer = vi.fn();
const headerValues = new Map<string, string>();

vi.mock('../api/server', () => ({ apiServer: (...args: unknown[]) => apiServer(...args) }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => headerValues.get(k) ?? null }) }));
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
  apiServer.mockReset();
  headerValues.clear();
});

describe('getMe', () => {
  it('returns the validated user', async () => {
    apiServer.mockResolvedValue({ ok: true, data: me() });
    expect(await getMe()).toEqual(me());
  });

  it.each([
    ['API down', { ok: false, status: 0, code: 'network' }],
    ['non-2xx', { ok: false, status: 401, code: 'unauthenticated' }],
    ['malformed body', { ok: true, data: { id: 'u1', role: 'root' } }],
    ['empty body', { ok: true, data: undefined }],
  ])('returns null on %s', async (_n, result) => {
    apiServer.mockResolvedValue(result);
    expect(await getMe()).toBeNull();
  });
});

describe('requireUser', () => {
  it('redirects to login with the encoded safe path when there is no session', async () => {
    apiServer.mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
    headerValues.set('x-dl-path', '/admin/utilisateurs?role=affiliate');
    await expect(requireUser(['super_manager'])).rejects.toThrow(
      'REDIRECT:/connexion?next=%2Fadmin%2Futilisateurs%3Frole%3Daffiliate',
    );
  });

  it.each([
    ['API down', { ok: false, status: 0, code: 'network' }],
    ['server error', { ok: false, status: 500, code: 'bad_response' }],
    ['malformed body', { ok: true, data: { nope: true } }],
  ])('treats %s as no session and never returns a user', async (_n, result) => {
    apiServer.mockResolvedValue(result);
    headerValues.set('x-dl-path', '/admin');
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/connexion?next=%2Fadmin');
  });

  it.each(['//evil.com', '/api/auth/me', 'https://evil.com', '/connexion'])('ignores a spoofed x-dl-path %s', async (value) => {
    apiServer.mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
    headerValues.set('x-dl-path', value);
    await expect(requireUser(['affiliate'])).rejects.toThrow('REDIRECT:/connexion');
    await expect(requireUser(['affiliate'])).rejects.not.toThrow('next=');
  });

  it('redirects to login without next when the header is absent', async () => {
    apiServer.mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
    await expect(requireUser(['affiliate'])).rejects.toThrow(/^REDIRECT:\/connexion$/);
  });

  it('redirects a wrong role to its own home', async () => {
    apiServer.mockResolvedValue({ ok: true, data: me({ role: 'affiliate' }) });
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/affiliate');
    apiServer.mockResolvedValue({ ok: true, data: me({ role: 'sub_manager' }) });
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/manager');
  });

  it('redirects to 2FA enrolment when required', async () => {
    apiServer.mockResolvedValue({ ok: true, data: me({ role: 'super_manager', mustEnroll2fa: true }) });
    await expect(requireUser(['super_manager'])).rejects.toThrow('REDIRECT:/compte/securite?setup=1');
  });

  it('does not redirect during enrolment when allowDuring2faEnrollment is set', async () => {
    const user = me({ role: 'super_manager', mustEnroll2fa: true });
    apiServer.mockResolvedValue({ ok: true, data: user });
    expect(await requireUser(['super_manager'], { allowDuring2faEnrollment: true })).toEqual(user);
  });

  it('returns the user for an allowed role', async () => {
    apiServer.mockResolvedValue({ ok: true, data: me() });
    expect(await requireUser(['affiliate', 'sub_manager'])).toEqual(me());
  });
});

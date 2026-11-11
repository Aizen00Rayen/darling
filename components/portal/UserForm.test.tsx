// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERMISSIONS } from '@/shared';
import type { Permission, Role, User } from '@/shared';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh, replace: vi.fn() }) }));
const api = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: (...args: unknown[]) => api(...args) }));

import { UserForm } from './UserForm';

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ ok: true, data: { id: 'new-id' } });
});
afterEach(cleanup);

function user(over: Partial<User> & { role: Role }): User {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    email: 'someone@example.test',
    fullName: 'Someone Else',
    phone: null,
    status: 'active',
    isOwner: false,
    permissions: [],
    twoFactorEnabled: false,
    lastLoginAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

async function submitEdit(target: User, props: { meIsOwner: boolean; meId?: string }, rename = 'Renamed Person') {
  const u = userEvent.setup();
  render(<UserForm mode="edit" {...props} user={target} />);
  const name = screen.getByLabelText('Nom complet');
  await u.clear(name);
  await u.type(name, rename);
  await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  return api.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
}

describe('UserForm (edit): what is sent', () => {
  it('an owner target: name only — never permissions, isOwner or role (the 14 effective permissions must not become grants)', async () => {
    const owner = user({ role: 'super_manager', isOwner: true, permissions: [...PERMISSIONS] as Permission[] });
    const [path, init] = await submitEdit(owner, { meIsOwner: true, meId: 'some-other-owner' });
    expect(path).toBe(`/api/users/${owner.id}`);
    expect(init.method).toBe('PATCH');
    expect(init.body).toEqual({ fullName: 'Renamed Person' });
    expect('permissions' in init.body).toBe(false);
    expect('isOwner' in init.body).toBe(false);
  });

  it('an owner editing themselves: name (and phone) only', async () => {
    const me = user({ role: 'super_manager', isOwner: true, permissions: [...PERMISSIONS] as Permission[], phone: '0550123456' });
    const [, init] = await submitEdit(me, { meIsOwner: true, meId: me.id });
    expect(init.body).toEqual({ fullName: 'Renamed Person', phone: '0550123456' });
  });

  it('a non-owner super manager editing themselves: name and phone only, and the form shows no permission checkboxes', async () => {
    const me = user({ role: 'super_manager', permissions: ['users.manage'] });
    const { container } = render(<UserForm mode="edit" meIsOwner={false} meId={me.id} user={me} />);
    expect(container.querySelectorAll('input[name="permissions"]')).toHaveLength(0);
    cleanup();
    const [, init] = await submitEdit(me, { meIsOwner: false, meId: me.id });
    expect(init.body).toEqual({ fullName: 'Renamed Person' });
  });

  it('a non-owner super manager target edited by an owner still sends its grants (and the role)', async () => {
    const sm = user({ role: 'super_manager', permissions: ['audit.read'] });
    const [, init] = await submitEdit(sm, { meIsOwner: true, meId: 'owner-id' });
    expect(init.body).toEqual({ fullName: 'Renamed Person', role: 'super_manager', permissions: ['audit.read'] }); // isOwner only when it changed
  });

  it('promoting a super manager to owner sends the flag and no grants', async () => {
    const sm = user({ role: 'super_manager', permissions: ['audit.read'] });
    const u = userEvent.setup();
    render(<UserForm mode="edit" meIsOwner meId="owner-id" user={sm} />);
    await u.click(screen.getByLabelText('Propriétaire (toutes les permissions)'));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(api).toHaveBeenCalled());
    const body = (api.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    expect(body.isOwner).toBe(true);
    expect('permissions' in body).toBe(false);
  });

  it('a co-owner target: the owner checkbox is available, no permission list, and isOwner is sent only when it changed', async () => {
    const co = user({ role: 'super_manager', isOwner: true, permissions: [...PERMISSIONS] as Permission[] });
    const u = userEvent.setup();
    const { container } = render(<UserForm mode="edit" meIsOwner meId="other-owner" user={co} />);
    expect(container.querySelectorAll('input[name="permissions"]')).toHaveLength(0);
    const box = screen.getByLabelText('Propriétaire (toutes les permissions)') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect((api.mock.calls[0] as [string, { body: object }])[1].body).toEqual({ fullName: 'Someone Else' });
    api.mockClear();
    await u.click(box);
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const body = (api.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    expect(body).toEqual({ fullName: 'Someone Else', isOwner: false });
    expect('permissions' in body).toBe(false);
  });

  it('an owner editing themselves has no owner checkbox', () => {
    const me = user({ role: 'super_manager', isOwner: true, permissions: [...PERMISSIONS] as Permission[] });
    render(<UserForm mode="edit" meIsOwner meId={me.id} user={me} />);
    expect(screen.queryByLabelText('Propriétaire (toutes les permissions)')).toBeNull();
  });

  it('an affiliate target: name, phone and role only', async () => {
    const aff = user({ role: 'affiliate' });
    const [, init] = await submitEdit(aff, { meIsOwner: true, meId: 'owner-id' });
    expect(init.body).toEqual({ fullName: 'Renamed Person', role: 'affiliate' });
  });

  it('clearing the phone field sends null; an untouched empty phone sends nothing', async () => {
    const withPhone = user({ role: 'affiliate', phone: '0550123456' });
    const u = userEvent.setup();
    render(<UserForm mode="edit" meIsOwner meId="o" user={withPhone} />);
    await u.clear(screen.getByLabelText(/Téléphone/));
    await u.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect((api.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body.phone).toBeNull();
    cleanup();
    api.mockClear();
    const [, init] = await submitEdit(user({ role: 'affiliate' }), { meIsOwner: true, meId: 'o' });
    expect('phone' in init.body).toBe(false);
  });

  it('a sub manager target: name, phone and role, no permission fields', async () => {
    const sub = user({ role: 'sub_manager' });
    const [, init] = await submitEdit(sub, { meIsOwner: false, meId: 'manager-id' });
    expect(init.body).toEqual({ fullName: 'Renamed Person', role: 'sub_manager' });
  });

  it('shows French explanations instead of the permission list for an owner', () => {
    const owner = user({ role: 'super_manager', isOwner: true, permissions: [...PERMISSIONS] as Permission[] });
    render(<UserForm mode="edit" meIsOwner meId="x" user={owner} />);
    expect(screen.getByText(/Un propriétaire dispose de toutes les permissions/)).toBeTruthy();
  });
});

describe('UserForm (create)', () => {
  it('still sends email, role and the chosen grants for a new super manager', async () => {
    const u = userEvent.setup();
    render(<UserForm mode="create" meIsOwner />);
    await u.type(screen.getByLabelText('Nom complet'), 'New Person');
    await u.type(screen.getByLabelText('Adresse e-mail'), 'new@example.test');
    await u.selectOptions(screen.getByLabelText('Rôle'), 'super_manager');
    await u.click(screen.getByLabelText('Gérer les utilisateurs'));
    await u.click(screen.getByRole('button', { name: 'Envoyer l’invitation' }));
    await waitFor(() => expect(api).toHaveBeenCalled());
    const [path, init] = api.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
    expect(path).toBe('/api/users');
    expect(init.method).toBe('POST');
    expect(init.body).toEqual({ fullName: 'New Person', email: 'new@example.test', role: 'super_manager', permissions: ['users.manage'], isOwner: false });
  });

  it('a manager who is not an owner cannot pick the super manager role', () => {
    render(<UserForm mode="create" meIsOwner={false} />);
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('super_manager');
  });
});

'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '@/ui';
import { PERMISSIONS, PERMISSION_LABELS, ROLES, ROLE_LABELS } from '@/shared';
import type { Permission, Role, User } from '@/shared';
import { api } from '@/lib/api/client';
import { apiMessage, fieldErrorsOf } from '@/lib/portal/messages';

type Props = {
  mode: 'create' | 'edit';
  /** Whether the signed-in user is an owner: only owners may create or edit Super Managers. */
  meIsOwner: boolean;
  user?: User;
};

const KNOWN_FIELDS = ['email', 'fullName', 'phone', 'role', 'permissions', 'isOwner'];

export function UserForm({ mode, meIsOwner, user }: Props) {
  const router = useRouter();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'sub_manager');
  const [isOwner, setIsOwner] = useState(user?.isOwner ?? false);
  const [permissions, setPermissions] = useState<Permission[]>(user?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Super Managers may only be created/edited by owners; an owner's role is fixed by the API.
  const roleOptions: Role[] = ROLES.filter((r) => r !== 'super_manager' || meIsOwner);
  const roleLocked = mode === 'edit' && Boolean(user?.isOwner);
  const showPermissions = role === 'super_manager';
  const showOwner = role === 'super_manager' && meIsOwner;

  function togglePermission(permission: Permission, checked: boolean) {
    setPermissions((current) => (checked ? [...new Set([...current, permission])] : current.filter((p) => p !== permission)));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setSaved(false);
    setFieldErrors({});

    const local: Record<string, string> = {};
    if (fullName.trim().length < 2) local.fullName = 'Le nom est requis.';
    if (mode === 'create' && email.trim() === '') local.email = 'Adresse e-mail requise.';
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      return;
    }

    const body: Record<string, unknown> = { fullName: fullName.trim(), role };
    if (phone.trim() !== '') body.phone = phone.trim();
    if (mode === 'create') body.email = email.trim();
    if (showPermissions) {
      body.permissions = permissions;
      if (showOwner) body.isOwner = isOwner;
    }

    setBusy(true);
    const result =
      mode === 'create'
        ? await api<User>('/api/users', { method: 'POST', body })
        : await api<User>(`/api/users/${user?.id ?? ''}`, { method: 'PATCH', body });
    setBusy(false);

    if (!result.ok) {
      const errors = fieldErrorsOf(result);
      if (result.code === 'email_taken') errors.email = apiMessage('email_taken');
      setFieldErrors(errors);
      const unmapped = Object.entries(errors).filter(([key]) => !KNOWN_FIELDS.includes(key));
      if (result.code === 'validation' && unmapped.length === 0 && Object.keys(errors).length > 0) return;
      setError(
        result.code === 'validation' && unmapped.length > 0
          ? unmapped.map(([, message]) => message).join(' ')
          : result.code === 'email_taken'
            ? null
            : apiMessage(result.code),
      );
      return;
    }

    if (mode === 'create') {
      router.push(`/admin/utilisateurs/${result.data.id}?created=1`);
      router.refresh();
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form className="p-form" method="post" onSubmit={onSubmit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="success">Modifications enregistrées.</Notice> : null}

      <div className="p-grid p-grid--2">
        <Field label="Nom complet" error={fieldErrors.fullName}>
          <input type="text" name="fullName" autoComplete="off" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        {mode === 'create' ? (
          <Field label="Adresse e-mail" error={fieldErrors.email}>
            <input
              type="email"
              name="email"
              autoComplete="off"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        ) : (
          <Field label="Adresse e-mail" hint="L’adresse e-mail ne peut pas être modifiée.">
            <input type="email" value={email} readOnly />
          </Field>
        )}
        <Field
          label="Téléphone (facultatif)"
          hint="Numéro mobile algérien, par exemple 0550 12 34 56."
          error={fieldErrors.phone}
        >
          <input type="tel" name="phone" autoComplete="off" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field
          label="Rôle"
          error={fieldErrors.role}
          hint={roleLocked ? 'Le rôle d’un propriétaire ne peut pas être modifié.' : undefined}
        >
          <select
            name="role"
            value={role}
            disabled={roleLocked}
            onChange={(e) => {
              setRole(e.target.value as Role);
              if (e.target.value !== 'super_manager') setIsOwner(false);
            }}
          >
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {showPermissions ? (
        <fieldset className="p-fieldset">
          <legend>Permissions</legend>
          {showOwner ? (
            <label className="p-check">
              <input type="checkbox" name="isOwner" checked={isOwner} onChange={(e) => setIsOwner(e.target.checked)} />
              <span>Propriétaire (toutes les permissions)</span>
            </label>
          ) : null}
          <div className="p-checks">
            {PERMISSIONS.map((permission) => (
              <label className="p-check" key={permission}>
                <input
                  type="checkbox"
                  name="permissions"
                  value={permission}
                  checked={isOwner || permissions.includes(permission)}
                  disabled={isOwner}
                  onChange={(e) => togglePermission(permission, e.target.checked)}
                />
                <span>{PERMISSION_LABELS[permission]}</span>
              </label>
            ))}
          </div>
          {fieldErrors.permissions ? <p className="dl-field__error">{fieldErrors.permissions}</p> : null}
        </fieldset>
      ) : null}

      <div className="p-form__actions">
        <Button type="submit" busy={busy}>
          {mode === 'create' ? 'Envoyer l’invitation' : 'Enregistrer'}
        </Button>
      </div>
    </form>
  );
}

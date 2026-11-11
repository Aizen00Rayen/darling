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
  /** The signed-in user's id: editing yourself only ever changes your name and phone. */
  meId?: string;
  user?: User;
  /** Active sous-managers an influenceuse can be assigned to (fetched on the server by the page). */
  managers?: { id: string; fullName: string }[];
};

const KNOWN_FIELDS = ['email', 'fullName', 'phone', 'role', 'permissions', 'isOwner', 'managerUserId'];

export function UserForm({ mode, meIsOwner, meId, user, managers = [] }: Props) {
  const router = useRouter();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'sub_manager');
  const [isOwner, setIsOwner] = useState(user?.isOwner ?? false);
  const [permissions, setPermissions] = useState<Permission[]>(user?.permissions ?? []);
  const [managerId, setManagerId] = useState(user?.affiliate?.managerUserId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Super Managers may only be created/edited by owners (and everyone may edit themselves).
  const roleOptions: Role[] = ROLES.filter((r) => r !== 'super_manager' || meIsOwner || user?.role === 'super_manager');
  // Editing yourself only ever changes name and phone: nobody changes their own role or permissions.
  const profileOnly = mode === 'edit' && user !== undefined && user.id === meId;
  // Another owner's record: name, phone and the owner flag. An owner holds every permission, so the 14 EFFECTIVE
  // permissions shown for an owner are never sent back as grants (that was a bug: the API now ignores them too).
  const ownerTarget = mode === 'edit' && Boolean(user?.isOwner) && !profileOnly;
  const roleLocked = profileOnly || ownerTarget;
  const showPermissions = role === 'super_manager' && !profileOnly && !ownerTarget;
  const showOwner = role === 'super_manager' && meIsOwner && !profileOnly;

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

    const body: Record<string, unknown> = { fullName: fullName.trim() };
    if (phone.trim() !== '') body.phone = phone.trim();
    else if (mode === 'edit' && user?.phone) body.phone = null; // the field was emptied: clear the number
    if (ownerTarget) {
      if (isOwner !== user?.isOwner) body.isOwner = isOwner;
    } else if (!profileOnly) {
      body.role = role;
      if (mode === 'create') body.email = email.trim();
      if (role === 'affiliate') {
        // Only a change is sent: the manager affects future orders only, and every change is audited.
        const current = user?.affiliate?.managerUserId ?? '';
        if (mode === 'create' ? managerId !== '' : managerId !== current) body.managerUserId = managerId === '' ? null : managerId;
      }
      if (showPermissions) {
        // An owner's permissions are implicit: grants are sent only for someone who is not being made an owner.
        if (!isOwner) body.permissions = permissions;
        if (showOwner && (mode === 'create' || isOwner !== user?.isOwner)) body.isOwner = isOwner;
      }
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

      {role === 'affiliate' && !profileOnly ? (
        <Field
          label="Sous-manager"
          error={fieldErrors.managerUserId}
          hint="Il touche une commission sur les commandes livrées de l’influenceuse. Un changement ne concerne que les prochaines commandes."
        >
          <select name="managerUserId" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">Aucun sous-manager</option>
            {managerId !== '' && !managers.some((m) => m.id === managerId) ? (
              <option value={managerId}>{user?.affiliate?.managerName ?? 'Sous-manager actuel'} (inactif)</option>
            ) : null}
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {(profileOnly || ownerTarget) && role === 'super_manager' ? (
        <p className="p-lead">
          {user?.isOwner
            ? 'Un propriétaire dispose de toutes les permissions ; son rôle et ses permissions ne se modifient pas ici.'
            : 'Vous ne pouvez pas modifier votre propre rôle ni vos permissions.'}
        </p>
      ) : null}

      {ownerTarget && showOwner ? (
        <label className="p-check">
          <input type="checkbox" name="isOwner" checked={isOwner} onChange={(e) => setIsOwner(e.target.checked)} />
          <span>Propriétaire (toutes les permissions)</span>
        </label>
      ) : null}

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

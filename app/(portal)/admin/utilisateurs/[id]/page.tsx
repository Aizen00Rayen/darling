import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader } from '@/ui';
import { PERMISSION_LABELS, ROLE_LABELS, userSchema } from '@/shared';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { UserActions } from '@/components/portal/UserActions';
import { UserForm } from '@/components/portal/UserForm';
import { apiServer } from '@/lib/api/server';
import { formatDateTime, formatLastLogin } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { statusLabel, statusTone } from '@/lib/portal/labels';
import { apiMessage } from '@/lib/portal/messages';
import { firstParam } from '@/lib/portal/query';

export const metadata: Metadata = { title: 'Utilisateur — Darling', robots: { index: false } };

// Only ever put into an API path when it has the shape of a UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function UserDetailPage(props: PageProps<'/admin/utilisateurs/[id]'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ params, searchParams }: PageProps<'/admin/utilisateurs/[id]'>) {
  const [me, { id }, sp] = await Promise.all([requireAdmin(), params, searchParams]);
  if (!me.permissions.includes('users.manage')) return <AccessDenied />;

  const back = (
    <Link className="p-back" href="/admin/utilisateurs">
      ← Utilisateurs
    </Link>
  );
  if (!UUID.test(id)) {
    return (
      <div className="p-stack">
        {back}
        <Notice tone="error">{apiMessage('not_found')}</Notice>
      </div>
    );
  }

  const result = await apiServer<unknown>(`/api/users/${encodeURIComponent(id)}`);
  const parsed = result.ok ? userSchema.safeParse(result.data) : null;
  if (!result.ok || !parsed?.success) {
    return (
      <div className="p-stack">
        {back}
        <Notice tone="error">{apiMessage(result.ok ? 'generic' : result.code)}</Notice>
      </div>
    );
  }
  const user = parsed.data;
  const canEdit = user.role !== 'super_manager' || me.isOwner;
  const created = firstParam(sp.created) === '1';

  return (
    <div className="p-stack p-stack--lg">
      {back}
      <PageHeader
        eyebrow="Utilisateur"
        title={user.fullName}
        actions={<Badge tone={statusTone(user.status)}>{statusLabel(user.status)}</Badge>}
      />
      {created ? <Notice tone="success">Invitation envoyée à {user.email}.</Notice> : null}

      <section className="p-card glass" aria-labelledby="d-info">
        <h2 className="p-card__title" id="d-info">
          Informations
        </h2>
        <dl className="p-dl">
          <div>
            <dt>E-mail</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Téléphone</dt>
            <dd>{user.phone ?? '—'}</dd>
          </div>
          <div>
            <dt>Rôle</dt>
            <dd>{user.isOwner ? 'Super Manager (propriétaire)' : ROLE_LABELS[user.role]}</dd>
          </div>
          <div>
            <dt>Double authentification</dt>
            <dd>{user.twoFactorEnabled ? 'Activée' : 'Non activée'}</dd>
          </div>
          <div>
            <dt>Dernière connexion</dt>
            <dd>{formatLastLogin(user.lastLoginAt)}</dd>
          </div>
          <div>
            <dt>Créé le</dt>
            <dd>{formatDateTime(user.createdAt)}</dd>
          </div>
          {user.role === 'super_manager' ? (
            <div>
              <dt>Permissions</dt>
              <dd>
                {user.isOwner
                  ? 'Toutes (propriétaire)'
                  : user.permissions.length > 0
                    ? user.permissions.map((p) => PERMISSION_LABELS[p]).join(' · ')
                    : 'Aucune'}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="p-card glass" aria-labelledby="d-actions">
        <h2 className="p-card__title" id="d-actions">
          Actions
        </h2>
        <UserActions user={user} meId={me.id} meIsOwner={me.isOwner} />
      </section>

      {canEdit ? (
        <section className="p-card glass" aria-labelledby="d-edit">
          <h2 className="p-card__title" id="d-edit">
            Modifier
          </h2>
          <UserForm mode="edit" meIsOwner={me.isOwner} user={user} />
        </section>
      ) : null}
    </div>
  );
}


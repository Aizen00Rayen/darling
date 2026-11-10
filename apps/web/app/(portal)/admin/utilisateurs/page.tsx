import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader, Table } from '@darling/ui';
import { ROLES, ROLE_LABELS, USER_STATUSES, userSchema } from '@darling/shared';
import type { Role, User, UserStatus } from '@darling/shared';
import { z } from 'zod';
import { Pager } from '@/components/portal/Pager';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { apiServer } from '@/lib/api/server';
import { formatLastLogin } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { statusLabel, statusTone } from '@/lib/portal/labels';
import { apiMessage } from '@/lib/portal/messages';
import { buildHref, firstParam, parsePage } from '@/lib/portal/query';

export const metadata: Metadata = { title: 'Utilisateurs — Darling', robots: { index: false } };

const PAGE_SIZE = 50;
const BASE = '/admin/utilisateurs';
const listSchema = z.object({ items: z.array(userSchema), total: z.number() });

export default function UsersPage(props: PageProps<'/admin/utilisateurs'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps<'/admin/utilisateurs'>) {
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('users.manage')) return <AccessDenied />;

  const roleParam = firstParam(sp.role);
  const statusParam = firstParam(sp.status);
  const role = ROLES.find((r) => r === roleParam);
  const status = USER_STATUSES.find((s) => s === statusParam);
  const q = firstParam(sp.q)?.slice(0, 100);
  const page = parsePage(sp.page);

  const result = await apiServer<unknown>(buildHref('/api/users', { role, status, q, page }));
  const parsed = result.ok ? listSchema.safeParse(result.data) : null;

  const filters = { role, status, q };
  return (
    <div className="p-stack">
      <PageHeader
        eyebrow="Administration"
        title="Utilisateurs"
        actions={
          <Link className="dl-btn dl-btn--primary" href={`${BASE}/nouveau`}>
            Nouvel utilisateur
          </Link>
        }
      />

      <form className="p-filters glass" method="get" action={BASE} role="search" aria-label="Filtrer les utilisateurs">
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="f-q">
            Recherche
          </label>
          <input id="f-q" type="search" name="q" defaultValue={q ?? ''} placeholder="Nom, e-mail ou téléphone" maxLength={100} />
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="f-role">
            Rôle
          </label>
          <select id="f-role" name="role" defaultValue={role ?? ''}>
            <option value="">Tous les rôles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="f-status">
            Statut
          </label>
          <select id="f-status" name="status" defaultValue={status ?? ''}>
            <option value="">Tous les statuts</option>
            {USER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="p-filters__actions">
          <button type="submit" className="dl-btn dl-btn--primary">
            Filtrer
          </button>
          <Link className="dl-btn dl-btn--ghost" href={BASE}>
            Réinitialiser
          </Link>
        </div>
      </form>

      {!result.ok ? (
        <Notice tone="error">{apiMessage(result.code)}</Notice>
      ) : !parsed?.success ? (
        <Notice tone="error">{apiMessage('generic')}</Notice>
      ) : (
        <>
          <Table<User>
            rows={parsed.data.items}
            empty="Aucun utilisateur ne correspond à ces critères."
            columns={[
              {
                key: 'name',
                header: 'Nom',
                render: (u) => (
                  <Link className="p-linkbtn" href={`${BASE}/${u.id}`}>
                    {u.fullName}
                  </Link>
                ),
              },
              { key: 'email', header: 'E-mail', render: (u) => u.email },
              { key: 'role', header: 'Rôle', render: (u) => <RoleBadge role={u.role} owner={u.isOwner} /> },
              { key: 'status', header: 'Statut', render: (u) => <StatusBadge status={u.status} /> },
              { key: '2fa', header: '2FA', hideBelow: 'sm', render: (u) => (u.twoFactorEnabled ? <span aria-label="Activée">✓</span> : <span aria-label="Non activée">—</span>) },
              { key: 'last', header: 'Dernière connexion', hideBelow: 'md', render: (u) => formatLastLogin(u.lastLoginAt) },
            ]}
          />
          <Pager page={page} total={parsed.data.total} pageSize={PAGE_SIZE} hrefFor={(p) => buildHref(BASE, { ...filters, page: p })} />
        </>
      )}
    </div>
  );
}

function RoleBadge({ role, owner }: { role: Role; owner: boolean }) {
  return <Badge tone={role === 'super_manager' ? 'pink' : 'neutral'}>{owner ? 'Propriétaire' : ROLE_LABELS[role]}</Badge>;
}

function StatusBadge({ status }: { status: UserStatus }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

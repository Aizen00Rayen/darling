import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/ui';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { UserForm } from '@/components/portal/UserForm';
import { requireAdmin } from '@/lib/portal/guards';

export const metadata: Metadata = { title: 'Nouvel utilisateur — Darling', robots: { index: false } };

export default function NewUserPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAdmin();
  if (!me.permissions.includes('users.manage')) return <AccessDenied />;
  return (
    <div className="p-stack">
      <Link className="p-back" href="/admin/utilisateurs">
        ← Utilisateurs
      </Link>
      <PageHeader eyebrow="Utilisateurs" title="Nouvel utilisateur" />
      <section className="p-card glass" aria-label="Nouvel utilisateur">
        <p className="p-lead">Un e-mail d’invitation est envoyé : la personne choisit elle-même son mot de passe.</p>
        <UserForm mode="create" meIsOwner={me.isOwner} />
      </section>
    </div>
  );
}

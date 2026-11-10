import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice, PageHeader } from '@darling/ui';
import { requireAdmin } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';
import { navFor } from '@/lib/portal/nav';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

const DESCRIPTIONS: Record<string, string> = {
  '/admin/utilisateurs': 'Inviter, modifier et suspendre les comptes.',
  '/admin/journal': 'Actions d’administration et connexions.',
  '/admin/parametres': 'Sécurité et informations de l’entreprise.',
  '/compte/securite': 'Mot de passe et double authentification.',
};

export default function AdminHome() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAdmin();
  const links = navFor(me.role, me.permissions).filter((item) => item.href !== '/admin');
  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Administration" title={`Bonjour, ${firstName(me.fullName)}`} />
      <p className="p-lead">Bienvenue dans l’espace d’administration Darling.</p>
      <Notice tone="info">
        Les statistiques, commandes et commissions arriveront avec les prochaines étapes.
        <ul className="p-list">
          <li>Produits et stock</li>
          <li>Commandes et clients</li>
          <li>Finance et commissions</li>
        </ul>
      </Notice>
      <nav aria-label="Accès rapides">
        <div className="p-links">
          {links.map((item) => (
            <Link key={item.href} href={item.href} className="p-link-card glass">
              <strong>{item.label}</strong>
              <span>{DESCRIPTIONS[item.href]}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

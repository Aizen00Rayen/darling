import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import { Notice, PageHeader } from '@darling/ui';
import { requireManager } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

export default function ManagerHome() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireManager();
  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Sous-manager" title={`Bonjour, ${firstName(me.fullName)}`} />
      <p className="p-lead">Bienvenue dans votre espace de gestion. Vous retrouverez ici le suivi de votre équipe.</p>
      <Notice tone="info">
        Les statistiques, commandes et commissions arriveront avec les prochaines étapes.
        <ul className="p-list">
          <li>Votre équipe d’influenceuses</li>
          <li>Les commissions de votre équipe</li>
        </ul>
      </Notice>
    </div>
  );
}

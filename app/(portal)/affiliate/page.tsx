import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import { Notice, PageHeader } from '@/ui';
import { requireAffiliate } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

export default function AffiliateHome() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const me = await requireAffiliate();
  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Influenceuse" title={`Bonjour, ${firstName(me.fullName)}`} />
      <p className="p-lead">Bienvenue dans votre espace Darling. Vous suivrez ici votre activité d’affiliation.</p>
      <Notice tone="info">
        Les statistiques, commandes et commissions arriveront avec les prochaines étapes.
        <ul className="p-list">
          <li>Votre lien d’affiliation personnel</li>
          <li>Vos clics et vos ventes</li>
          <li>Vos commissions</li>
        </ul>
      </Notice>
    </div>
  );
}

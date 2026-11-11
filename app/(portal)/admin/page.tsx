import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Notice, PageHeader } from '@/ui';
import { ORDER_STATUSES } from '@/shared';
import { orderStatusLabel } from '@/lib/portal/orders';
import { orderStats } from '@/server/orders/list';
import { getServerContext } from '@/server/context';
import { requireAdmin } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';
import { navFor } from '@/lib/portal/nav';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

const DESCRIPTIONS: Record<string, string> = {
  '/admin/commandes': 'Suivre, confirmer et expédier les commandes.',
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
      {me.permissions.includes('orders.read') ? <OrderStatsPanel /> : null}
      <Notice tone="info">
        D’autres statistiques arriveront avec les prochaines étapes.
        <ul className="p-list">
          <li>Produits et stock</li>
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

/** Order counts, read straight from the database (this component only renders for users holding orders.read). */
async function OrderStatsPanel() {
  await connection(); // request-time: counts change with every order
  const ctx = getServerContext();
  const stats = orderStats(ctx.db, ctx.clock.now());
  return (
    <section className="p-stack" aria-labelledby="d-orders">
      <h2 className="p-section-title" id="d-orders">
        Commandes
      </h2>
      <div className="p-stats">
        <Link href="/admin/commandes?status=new" className="p-stat glass p-stat--accent">
          <span className="p-stat__label">À traiter</span>
          <span className="p-stat__value">{stats.toProcess}</span>
          <span className="p-lead">Nouvelles commandes à confirmer</span>
        </Link>
        <div className="p-stat glass">
          <span className="p-stat__label">Aujourd’hui</span>
          <span className="p-stat__value">{stats.today}</span>
          <span className="p-lead">Commandes reçues aujourd’hui</span>
        </div>
        <Link href="/admin/commandes" className="p-stat glass">
          <span className="p-stat__label">Total</span>
          <span className="p-stat__value">{stats.total}</span>
          <span className="p-lead">Toutes les commandes</span>
        </Link>
      </div>
      <h3 className="p-section-title">Par statut</h3>
      <div className="p-stats">
        {ORDER_STATUSES.map((s) => (
          <Link key={s} href={`/admin/commandes?status=${s}`} className="p-stat glass">
            <span className="p-stat__label">{orderStatusLabel(s)}</span>
            <span className="p-stat__value">{stats.byStatus[s]}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

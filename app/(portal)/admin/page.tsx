import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Notice, PageHeader } from '@/ui';
import { ORDER_STATUSES } from '@/shared';
import { orderStatusLabel } from '@/lib/portal/orders';
import { orderStats } from '@/server/orders/list';
import { dashboardTotals } from '@/server/commissions/queries';
import { formatMoney } from '@/lib/pricing';
import { getServerContext } from '@/server/context';
import { requireAdmin } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';
import { navFor } from '@/lib/portal/nav';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

const DESCRIPTIONS: Record<string, string> = {
  '/admin/commandes': 'Suivre, confirmer et expédier les commandes.',
  '/admin/influenceuses': 'Codes, liens, clics et ventes de chaque influenceuse.',
  '/admin/commissions': 'Valider, retenir, annuler et payer les commissions.',
  '/admin/utilisateurs': 'Inviter, modifier et suspendre les comptes.',
  '/admin/journal': 'Actions d’administration et connexions.',
  '/admin/parametres': 'Sécurité et informations de l’entreprise.',
  '/admin/diagnostics': 'Adresse IP, sauvegardes, e-mails et état du serveur.',
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
  const links = navFor(me.role, me.permissions, { isOwner: me.isOwner }).filter((item) => item.href !== '/admin');
  return (
    <div className="p-stack p-stack--lg">
      <PageHeader eyebrow="Administration" title={`Bonjour, ${firstName(me.fullName)}`} />
      <p className="p-lead">Bienvenue dans l’espace d’administration Darling.</p>
      {me.permissions.includes('orders.read') ? <OrderStatsPanel /> : null}
      {me.permissions.includes('commissions.manage') ? <CommissionsPanel /> : null}
      <Notice tone="info">
        D’autres statistiques arriveront avec les prochaines étapes.
        <ul className="p-list">
          <li>Produits et stock</li>
          <li>Finance</li>
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

/** What is payable now (validated, not held) and what is still pending, read straight from the database (commissions.manage only). */
async function CommissionsPanel() {
  await connection(); // request-time: amounts change with every delivery and payout
  const totals = dashboardTotals(getServerContext().db);
  return (
    <section className="p-stack" aria-labelledby="d-commissions">
      <h2 className="p-section-title" id="d-commissions">
        Commissions
      </h2>
      <div className="p-stats">
        <Link href="/admin/commissions?status=validated" className="p-stat glass p-stat--accent">
          <span className="p-stat__label">Commissions à payer</span>
          <span className="p-stat__value">{formatMoney(totals.toPay)}</span>
          <span className="p-lead">Validées, prêtes à être payées</span>
        </Link>
        <Link href="/admin/commissions?status=pending" className="p-stat glass">
          <span className="p-stat__label">Commissions en attente</span>
          <span className="p-stat__value">{formatMoney(totals.pending)}</span>
          <span className="p-lead">Commandes pas encore livrées ou retenues</span>
        </Link>
      </div>
    </section>
  );
}

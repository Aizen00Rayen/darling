import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Badge } from '@/ui';
import { ORDER_STATUSES } from '@/shared';
import { orderStatusLabel, orderStatusTone } from '@/lib/portal/orders';
import { orderStats } from '@/server/orders/list';
import { dashboardTotals, listAffiliates } from '@/server/commissions/queries';
import { ensureDefaultProduct, listProducts } from '@/server/products/db';
import { formatMoney } from '@/lib/pricing';
import { getServerContext } from '@/server/context';
import { requireAdmin } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';
import { navFor } from '@/lib/portal/nav';
import { ArrowIcon, EyeIcon, PlusIcon, SparklesIcon } from '@/components/icons';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

const DESCRIPTIONS: Record<string, string> = {
  '/admin/commandes': 'Suivi direct, validation COD, expédition et livraisons.',
  '/admin/produits': 'Catalogue des produits, gestion des stocks et pages de vente.',
  '/admin/influenceuses': 'Codes promo, tracking des liens, clics et ventes des créatrices.',
  '/admin/commissions': 'Validation des gains sur livraisons et virements.',
  '/admin/utilisateurs': 'Création des sous-managers et des comptes influenceuses.',
  '/admin/journal': 'Audit des actions d’administration et sécurité.',
  '/admin/parametres': 'Paramètres de la marque et informations de l’entreprise.',
  '/admin/diagnostics': 'État du serveur, sauvegardes SQLite et santé système.',
  '/compte/securite': 'Double authentification TOTP et mot de passe.',
};

export default function AdminHome() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await connection();
  const me = await requireAdmin();
  const ctx = getServerContext();
  ensureDefaultProduct(ctx.db);

  const stats = me.permissions.includes('orders.read') ? orderStats(ctx.db, ctx.clock.now()) : null;
  const commissions = me.permissions.includes('commissions.manage') ? dashboardTotals(ctx.db) : null;
  const products = me.permissions.includes('catalog.write') ? listProducts(ctx.db) : [];
  const topAffiliates = me.permissions.includes('commissions.manage')
    ? listAffiliates(ctx.db, { page: 1 }, ctx.config.appOrigin).items.slice(0, 4)
    : [];

  // Compute total delivered revenue
  const deliveredRevenue = me.permissions.includes('orders.read')
    ? (ctx.db.get<{ s: number | null }>('SELECT sum(total) AS s FROM orders WHERE status = ?', 'delivered')?.s ?? 0)
    : 0;

  const links = navFor(me.role, me.permissions, { isOwner: me.isOwner }).filter((item) => item.href !== '/admin');

  return (
    <div className="p-stack p-stack--lg">
      {/* 1. Live System & Quick Action Bar */}
      <div className="dl-live-bar glass">
        <div className="dl-live-status">
          <span className="dl-pulse-dot" aria-hidden="true" />
          <span>Boutique en ligne active</span>
          {stats && stats.toProcess > 0 ? (
            <Link href="/admin/commandes?status=new" className="dl-pill-btn dl-pill-btn--primary">
              <span className="dl-pulse-dot dl-pulse-dot--pink" aria-hidden="true" />
              <span>{stats.toProcess} à confirmer</span>
            </Link>
          ) : (
            <Badge tone="success">Toutes traitées ✓</Badge>
          )}
        </div>
        <div className="dl-live-actions">
          {me.permissions.includes('catalog.write') ? (
            <Link href="/admin/produits/nouveau" className="dl-pill-btn">
              <PlusIcon /> Produit
            </Link>
          ) : null}
          {me.permissions.includes('users.manage') ? (
            <Link href="/admin/utilisateurs/nouveau" className="dl-pill-btn">
              <PlusIcon /> Utilisateur
            </Link>
          ) : null}
          {me.permissions.includes('orders.write') ? (
            <Link href="/admin/commandes/nouvelle" className="dl-pill-btn">
              <PlusIcon /> Commande
            </Link>
          ) : null}
        </div>
      </div>

      {/* 2. Hero Editorial Header */}
      <header className="dl-page-header">
        <div>
          <span className="dl-eyebrow">Atelier Darling ✦ Cockpit Propriétaire</span>
          <h1 className="dl-page-header__title">
            Bonjour, {firstName(me.fullName)} <span style={{ color: 'var(--pink-ink)' }}>✦</span>
          </h1>
          <p className="p-lead" style={{ marginTop: '8px' }}>
            Aperçu en temps réel de votre activité commerciale, de la logistique COD et de vos ambassadrices.
          </p>
        </div>
      </header>

      {/* 3. Radiant Hero KPI Cockpit */}
      {stats ? (
        <section aria-labelledby="d-kpis">
          <h2 className="p-section-title" id="d-kpis" style={{ marginBottom: '14px' }}>
            Indicateurs Clés
          </h2>
          <div className="p-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
            {/* Urgent: To Process */}
            <Link
              href="/admin/commandes?status=new"
              className={`p-stat--hero glass ${stats.toProcess > 0 ? 'p-stat--urgent' : ''}`}
            >
              <div className="p-stat__hero-header">
                <span className="dl-eyebrow" style={{ color: stats.toProcess > 0 ? 'var(--pink-ink)' : 'var(--muted)' }}>
                  Commandes à confirmer
                </span>
                {stats.toProcess > 0 ? <span className="dl-pulse-dot dl-pulse-dot--pink" /> : null}
              </div>
              <div className="p-stat__hero-val" style={{ color: stats.toProcess > 0 ? 'var(--pink-ink)' : 'inherit' }}>
                {stats.toProcess}
              </div>
              <div className="p-stat__hero-sub">
                {stats.toProcess > 0 ? 'Appels téléphoniques COD en attente' : 'Aucune commande en attente'}
              </div>
            </Link>

            {/* Total Delivered Revenue */}
            <div className="p-stat--hero glass">
              <div className="p-stat__hero-header">
                <span className="dl-eyebrow">Chiffre d’affaires encaissé</span>
                <SparklesIcon />
              </div>
              <div className="p-stat__hero-val">
                {formatMoney(deliveredRevenue)}
              </div>
              <div className="p-stat__hero-sub">
                {stats.byStatus.delivered} commande(s) livrée(s) et réglée(s)
              </div>
            </div>

            {/* Today Orders */}
            <div className="p-stat--hero glass">
              <div className="p-stat__hero-header">
                <span className="dl-eyebrow">Reçues aujourd’hui</span>
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>24h</span>
              </div>
              <div className="p-stat__hero-val">{stats.today}</div>
              <div className="p-stat__hero-sub">
                Sur un total de {stats.total} commande(s) enregistrée(s)
              </div>
            </div>

            {/* Validated Commissions Payable */}
            {commissions ? (
              <Link href="/admin/commissions?status=validated" className="p-stat--hero glass">
                <div className="p-stat__hero-header">
                  <span className="dl-eyebrow">Commissions à régler</span>
                  <ArrowIcon />
                </div>
                <div className="p-stat__hero-val" style={{ color: commissions.toPay > 0 ? 'var(--pink-ink)' : 'inherit' }}>
                  {formatMoney(commissions.toPay)}
                </div>
                <div className="p-stat__hero-sub">
                  Validées sur colis livrés, prêtes au paiement
                </div>
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 4. Visual Order Lifecycle Pipeline */}
      {stats ? (
        <section aria-labelledby="d-pipeline" className="p-stack">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 className="p-section-title" id="d-pipeline">
              Pipeline Logistique des Commandes
            </h2>
            <Link href="/admin/commandes" className="p-subtle" style={{ fontWeight: 600 }}>
              Voir toutes ({stats.total}) →
            </Link>
          </div>
          <div className="p-pipeline">
            {ORDER_STATUSES.map((status) => {
              const count = stats.byStatus[status];
              const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
              return (
                <Link
                  key={status}
                  href={`/admin/commandes?status=${status}`}
                  className="p-pipeline__card glass"
                >
                  <div className="p-pipeline__top">
                    <span className="p-pipeline__name">{orderStatusLabel(status)}</span>
                    <Badge tone={orderStatusTone(status)}>{count}</Badge>
                  </div>
                  <div className="p-pipeline__count">{count}</div>
                  <div className="p-pipeline__pct">{pct}% du volume total</div>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 5. Live Catalog & Inventory Widget */}
      {products.length > 0 ? (
        <section aria-labelledby="d-catalog" className="p-stack">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <h2 className="p-section-title" id="d-catalog">
                Catalogue Produits & Niveaux de Stock
              </h2>
            </div>
            {me.permissions.includes('catalog.write') ? (
              <div style={{ display: 'flex', gap: '8px' }}>
                <Link href="/admin/produits" className="p-subtle" style={{ fontWeight: 600 }}>
                  Gérer le catalogue ({products.length}) →
                </Link>
              </div>
            ) : null}
          </div>
          <div className="p-products-grid">
            {products.map((prod) => {
              const stockMax = 100;
              const fillPct = Math.min(100, Math.max(0, Math.round((prod.stock / stockMax) * 100)));
              const isLow = prod.stock <= 10;
              const productUrl = prod.isDefault ? '/' : `/produit/${prod.slug}`;

              return (
                <div key={prod.id} className="p-product-tile glass">
                  <div className="p-product-tile__header">
                    <div>
                      <div className="p-product-tile__title">{prod.name}</div>
                      <span className="p-subtle">Slug: /{prod.slug}</span>
                    </div>
                    <div className="p-product-tile__price">{formatMoney(prod.price)}</div>
                  </div>

                  <div>
                    <div className="p-product-tile__stock">
                      <span>Stock disponible</span>
                      <strong>{prod.stock} unités</strong>
                    </div>
                    <div className="p-stock-bar">
                      <div
                        className={`p-stock-bar__fill ${isLow ? 'p-stock-bar__fill--low' : ''}`}
                        style={{ width: `${fillPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="p-product-tile__actions">
                    <a
                      href={productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dl-pill-btn"
                      style={{ padding: '6px 14px', fontSize: '10px' }}
                    >
                      <EyeIcon /> Voir la page ↗
                    </a>
                    {me.permissions.includes('catalog.write') ? (
                      <Link
                        href={`/admin/produits/${prod.id}`}
                        className="dl-pill-btn"
                        style={{ padding: '6px 14px', fontSize: '10px' }}
                      >
                        Modifier
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 6. Top Ambassadrices / Leaderboard */}
      {topAffiliates.length > 0 ? (
        <section aria-labelledby="d-influencers" className="p-stack">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 className="p-section-title" id="d-influencers">
              Ambassadrices & Influenceuses Clés
            </h2>
            <Link href="/admin/influenceuses" className="p-subtle" style={{ fontWeight: 600 }}>
              Toutes les influenceuses →
            </Link>
          </div>
          <div className="p-leaderboard">
            {topAffiliates.map((aff) => {
              const initials = aff.name
                .split(' ')
                .map((w) => w[0])
                .slice(0, 2)
                .join('')
                .toUpperCase();

              return (
                <div key={aff.userId} className="p-leader-row glass">
                  <div className="p-leader-avatar">{initials}</div>
                  <div className="p-leader-info">
                    <span className="p-leader-name">{aff.name}</span>
                    <span className="p-leader-code">Code : {aff.code}</span>
                  </div>
                  <div className="p-leader-stats">
                    <span className="p-leader-orders">{aff.orders} commandes</span>
                    <span className="p-subtle">{aff.delivered} livrée(s)</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 7. Quick Navigation Modules */}
      <section aria-labelledby="d-modules" className="p-stack">
        <h2 className="p-section-title" id="d-modules">
          Modules d’Administration
        </h2>
        <nav aria-label="Accès rapides">
          <div className="p-links">
            {links.map((item) => (
              <Link key={item.href} href={item.href} className="p-link-card glass">
                <span className="p-link-card__arrow">↗</span>
                <strong>{item.label}</strong>
                <span>{DESCRIPTIONS[item.href] ?? 'Accéder au module.'}</span>
              </Link>
            ))}
          </div>
        </nav>
      </section>
    </div>
  );
}

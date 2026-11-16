import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { PageLoading } from '@/components/portal/PageLoading';
import { BarChart, Donut, Funnel, Sparkline } from '@/components/portal/dash/charts';
import '@/components/portal/dash/dashboard.css';
import { Badge } from '@/ui';
import { orderStatusLabel, orderStatusTone } from '@/lib/portal/orders';
import { orderStats, listOrders } from '@/server/orders/list';
import { dashboardTotals, listAffiliates } from '@/server/commissions/queries';
import { monthReport } from '@/server/finance/reports';
import { readOverview } from '@/server/inventory/stock';
import { formatMoney } from '@/lib/pricing';
import { getServerContext } from '@/server/context';
import { requireAdmin } from '@/lib/portal/guards';
import { firstName } from '@/lib/portal/names';
import { navFor } from '@/lib/portal/nav';
import { algiersDateString } from '@/server/util/algiers';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

const DESCRIPTIONS: Record<string, string> = {
  '/admin/commandes': 'Ajouter, modifier, confirmer et supprimer les commandes.',
  '/admin/produits': 'Catalogue, prix de vente et pages produit.',
  '/admin/stock': 'Stock par teinte, prix d’achat, ventes hors site.',
  '/admin/rapports': 'Bénéfices du mois, graphiques et export CSV.',
  '/admin/influenceuses': 'Codes promo, clics et ventes des créatrices.',
  '/admin/commissions': 'Validation des gains et virements.',
  '/admin/utilisateurs': 'Créer, modifier et supprimer les comptes.',
  '/admin/journal': 'Audit des actions d’administration.',
  '/admin/parametres': 'Informations de la marque et de l’entreprise.',
  '/admin/diagnostics': 'Santé du serveur et sauvegardes.',
  '/compte/securite': 'Double authentification et mot de passe.',
};

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const prevMonth = (m: string) => {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
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
  const can = (p: (typeof me.permissions)[number]) => me.permissions.includes(p);
  const finance = can('finance.read');

  const now = ctx.clock.now();
  const today = algiersDateString(now);
  const month = today.slice(0, 7);
  const stats = can('orders.read') ? orderStats(ctx.db, now) : null;
  const report = can('orders.read') || finance ? monthReport(ctx.db, month) : null;
  const previous = report ? monthReport(ctx.db, prevMonth(month)) : null;
  const commissions = can('commissions.manage') ? dashboardTotals(ctx.db) : null;
  const stock = can('stock.write') || can('catalog.write') ? readOverview(ctx.db, { withCost: finance }).filter((p) => p.isActive) : [];
  const recent = can('orders.read') ? listOrders(ctx.db, { page: 1 }).items.slice(0, 7) : [];
  const topAffiliates = can('commissions.manage') ? listAffiliates(ctx.db, { page: 1 }, ctx.config.appOrigin).items.slice(0, 4) : [];
  const links = navFor(me.role, me.permissions, { isOwner: me.isOwner }).filter((item) => item.href !== '/admin');

  // Days of the month so far, with zeros for quiet days.
  const dayCount = Number(today.slice(8, 10));
  const byDay = new Map((report?.daily ?? []).map((d) => [d.date, d]));
  const days = Array.from({ length: dayCount }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const d = byDay.get(date);
    return { label: date, sales: d?.sales ?? 0, profit: finance ? (d?.profit ?? 0) : null };
  });

  const total = report ? report.realised.profit + report.pipeline.profit : 0;
  const prevTotal = previous ? previous.realised.profit + previous.pipeline.profit : 0;
  const salesNow = report ? report.realised.sales + report.pipeline.sales : 0;
  const salesPrev = previous ? previous.realised.sales + previous.pipeline.sales : 0;
  const heroNow = finance ? total : salesNow;
  const heroPrev = finance ? prevTotal : salesPrev;
  const delta = heroPrev > 0 ? Math.round(((heroNow - heroPrev) / heroPrev) * 100) : null;
  let running = 0;
  const cumulative = days.map((d) => (running += finance ? (d.profit ?? 0) : d.sales));

  return (
    <div className="dd">
      <section className="dd-hero" aria-labelledby="dd-title">
        <div>
          <p className="dd-hero__eyebrow">Atelier Darling · {monthLabel(month)}</p>
          <h1 id="dd-title">Bonjour {firstName(me.fullName)} ✦</h1>
          <p className="dd-hero__sub">
            {stats && stats.toProcess > 0
              ? `${stats.toProcess} commande${stats.toProcess > 1 ? 's' : ''} attend${stats.toProcess > 1 ? 'ent' : ''} votre appel de confirmation.`
              : 'Tout est à jour : aucune commande en attente de confirmation.'}
          </p>
          {report ? (
            <>
              <div className="dd-hero__big">
                {formatMoney(heroNow)}
              </div>
              <p className="dd-hero__sub" style={{ marginTop: 6 }}>
                {finance ? 'Profit net du mois (ventes − coût réel − commissions)' : 'Chiffre d’affaires du mois'}
                {finance && report.pipeline.profit > 0 ? ` · dont ${formatMoney(report.pipeline.profit)} en cours de livraison` : ''}
              </p>
              {delta !== null ? (
                <span className={`dd-delta ${delta >= 0 ? 'dd-delta--up' : 'dd-delta--down'}`}>
                  {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)} % vs mois dernier
                </span>
              ) : null}
            </>
          ) : null}
          <div className="dd-actions">
            {can('orders.write') ? (
              <Link href="/admin/commandes/nouvelle" className="dd-pill dd-pill--solid">
                + Nouvelle commande
              </Link>
            ) : null}
            {can('stock.write') ? (
              <Link href="/admin/stock#mouvement" className="dd-pill">
                Vente hors site
              </Link>
            ) : null}
            {finance ? (
              <Link href="/admin/rapports" className="dd-pill">
                Rapports & export CSV
              </Link>
            ) : null}
            {can('catalog.write') ? (
              <Link href="/admin/produits/nouveau" className="dd-pill">
                + Produit
              </Link>
            ) : null}
          </div>
        </div>
        <div className="dd-hero__chart">
          <Sparkline values={cumulative} label={finance ? 'Profit cumulé du mois' : 'Ventes cumulées du mois'} />
        </div>
      </section>


      {finance && stock.some((p) => (p.costPrice ?? 0) === 0) ? (
        <Link href="/admin/stock" className="dd-card dd-card--urgent" style={{ display: 'block' }}>
          <div className="dd-card__label">Profits incomplets</div>
          <div className="dd-card__sub" style={{ color: 'var(--ink)', fontSize: 14, marginTop: 6 }}>
            Le prix d’achat de {stock.filter((p) => (p.costPrice ?? 0) === 0).map((p) => p.name).join(', ')} n’est pas renseigné : les profits affichés ne déduisent aucun coût. Renseignez-le dans Stock →
          </div>
        </Link>
      ) : null}

      {stats && report ? (
        <section className="dd-grid4" aria-label="Indicateurs">
          <Link href="/admin/commandes?status=new" className={`dd-card ${stats.toProcess > 0 ? 'dd-card--urgent' : ''}`}>
            <div className="dd-card__label">
              À confirmer {stats.toProcess > 0 ? <span className="dd-pulse" aria-hidden="true" /> : null}
            </div>
            <div className="dd-card__val">{stats.toProcess}</div>
            <div className="dd-card__sub">{stats.toProcess > 0 ? 'Appels COD en attente' : 'Rien en attente'}</div>
          </Link>
          <div className="dd-card">
            <div className="dd-card__label">Reçues aujourd’hui</div>
            <div className="dd-card__val">{stats.today}</div>
            <div className="dd-card__sub">{stats.total} commandes au total</div>
          </div>
          <div className="dd-card">
            <div className="dd-card__label">Taux de livraison</div>
            <div className="dd-card__val">{report.deliveryRate === null ? '—' : <>{report.deliveryRate}<small>%</small></>}</div>
            <div className="dd-card__sub">Livrées sur les commandes clôturées ce mois</div>
          </div>
          <div className="dd-card">
            <div className="dd-card__label">Panier moyen</div>
            <div className="dd-card__val">{formatMoney(report.averageBasket)}</div>
            <div className="dd-card__sub">Ventes produit, hors livraison</div>
          </div>
          {finance ? (
            <>
              <div className="dd-card dd-card--good">
                <div className="dd-card__label">Bénéfice encaissé</div>
                <div className="dd-card__val">{formatMoney(report.realised.profit)}</div>
                <div className="dd-card__sub">Commandes livrées + ventes hors site</div>
              </div>
              <div className="dd-card">
                <div className="dd-card__label">Marge brute</div>
                <div className="dd-card__val">{formatMoney(report.realised.margin + report.pipeline.margin)}</div>
                <div className="dd-card__sub">Coût réel déjà déduit : {formatMoney(report.realised.cost + report.pipeline.cost)}</div>
              </div>
            </>
          ) : null}
          {commissions ? (
            <Link href="/admin/commissions?status=validated" className="dd-card">
              <div className="dd-card__label">Commissions à régler</div>
              <div className="dd-card__val">{formatMoney(commissions.toPay)}</div>
              <div className="dd-card__sub">Validées, prêtes au paiement</div>
            </Link>
          ) : null}
        </section>
      ) : null}

      {report ? (
        <section className="dd-two">
          <div className="dd-card">
            <div className="dd-h">
              <h2>Ventes de {monthLabel(month)}</h2>
              {finance ? <Link href="/admin/rapports">Détail →</Link> : null}
            </div>
            <BarChart data={days} showProfit={finance} />
            <p className="dd-key">
              <span>
                <i style={{ background: 'var(--pink)' }} />
                Ventes
              </span>
              {finance ? (
                <span>
                  <i style={{ background: 'var(--ink)' }} />
                  Part de profit
                </span>
              ) : null}
            </p>
          </div>
          <div className="dd-card">
            <div className="dd-h">
              <h2>Canaux de vente</h2>
            </div>
            <Donut data={report.bySource.map((s) => ({ label: s.label, value: s.sales }))} centre={formatMoney(salesNow)} />
          </div>
        </section>
      ) : null}

      {stats ? (
        <section className="dd-card" aria-labelledby="dd-pipe">
          <div className="dd-h">
            <h2 id="dd-pipe">Pipeline des commandes</h2>
            <Link href="/admin/commandes">Toutes les commandes ({stats.total}) →</Link>
          </div>
          <Funnel
            steps={[
              { label: 'Nouvelles', value: stats.byStatus.new, tone: 'new', href: '/admin/commandes?status=new' },
              { label: 'Confirmées', value: stats.byStatus.confirmed, tone: 'confirmed', href: '/admin/commandes?status=confirmed' },
              { label: 'Expédiées', value: stats.byStatus.shipped, tone: 'shipped', href: '/admin/commandes?status=shipped' },
              { label: 'Livrées', value: stats.byStatus.delivered, tone: 'delivered', href: '/admin/commandes?status=delivered' },
              { label: 'Annulées / refusées / retournées', value: stats.byStatus.cancelled + stats.byStatus.refused + stats.byStatus.returned, tone: 'bad', href: '/admin/commandes?status=cancelled' },
            ]}
          />
        </section>
      ) : null}

      <section className="dd-two">
        {recent.length > 0 ? (
          <div className="dd-card dd-orders">
            <div className="dd-h">
              <h2>Dernières commandes</h2>
              <Link href="/admin/commandes">Voir tout →</Link>
            </div>
            {recent.map((o) => (
              <Link key={o.id} href={`/admin/commandes/${o.id}`}>
                <span className="dd-av" aria-hidden="true">
                  {o.customerName.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                </span>
                <span>
                  <strong>{o.customerName}</strong>
                  <small>
                    {o.number} · {o.wilayaName}
                  </small>
                </span>
                <span style={{ textAlign: 'right' }}>
                  <strong>{formatMoney(o.total)}</strong>
                  <small>
                    <Badge tone={orderStatusTone(o.status)}>{orderStatusLabel(o.status)}</Badge>
                  </small>
                </span>
              </Link>
            ))}
          </div>
        ) : null}
        {stock.length > 0 ? (
          <div className="dd-card">
            <div className="dd-h">
              <h2>Stock</h2>
              {can('stock.write') ? <Link href="/admin/stock">Gérer →</Link> : null}
            </div>
            {(() => {
              const top = Math.max(1, ...stock.map((p) => p.total));
              return stock.map((p) => {
                const out = p.total <= 0;
                const low = !out && p.total <= p.lowStockThreshold;
                return (
                  <div key={p.id} className="dd-stockrow">
                    <strong>{p.name}</strong>
                    <span className={`dd-chip ${out ? 'dd-chip--out' : low ? 'dd-chip--low' : 'dd-chip--ok'}`}>{out ? 'Épuisé' : `${p.total} unités`}</span>
                    <span className="dd-stockrow__bar">
                      <i className={out ? 'is-out' : low ? 'is-low' : ''} style={{ width: `${Math.max(3, Math.round((p.total / top) * 100))}%` }} />
                    </span>
                    {finance && p.costPrice !== null ? (
                      <small style={{ gridColumn: '1/-1', color: 'var(--muted)' }}>
                        Achat {formatMoney(p.costPrice)} · vente {formatMoney(p.price)} · marge{' '}
                        <b className={p.price - p.costPrice >= 0 ? 'dd-pos' : 'dd-neg'}>{formatMoney(p.price - p.costPrice)}</b> / unité
                      </small>
                    ) : null}
                  </div>
                );
              });
            })()}
          </div>
        ) : null}
      </section>

      {report && (report.byProduct.length > 0 || report.byWilaya.length > 0) ? (
        <section className="dd-two" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="dd-card">
            <div className="dd-h">
              <h2>Produits du mois</h2>
            </div>
            <ul className="dd-list">
              {report.byProduct.slice(0, 5).map((p) => (
                <li key={p.key}>
                  <span>
                    {p.label}
                    <br />
                    <small>{p.count} vente(s)</small>
                  </span>
                  <b>{formatMoney(finance ? p.profit : p.sales)}</b>
                </li>
              ))}
            </ul>
          </div>
          <div className="dd-card">
            <div className="dd-h">
              <h2>Wilayas</h2>
            </div>
            <ul className="dd-list">
              {report.byWilaya.slice(0, 5).map((w) => (
                <li key={w.key}>
                  <span>
                    {w.label}
                    <br />
                    <small>{w.count} commande(s)</small>
                  </span>
                  <b>{formatMoney(w.sales)}</b>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {topAffiliates.length > 0 ? (
        <section className="dd-card">
          <div className="dd-h">
            <h2>Influenceuses clés</h2>
            <Link href="/admin/influenceuses">Toutes →</Link>
          </div>
          <ul className="dd-list">
            {topAffiliates.map((a) => (
              <li key={a.userId}>
                <span>
                  {a.name}
                  <br />
                  <small>Code {a.code}</small>
                </span>
                <b>
                  {a.orders} cmd · {a.delivered} livrée(s)
                </b>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="dd-mods">
        <div className="dd-h">
          <h2 id="dd-mods">Modules</h2>
        </div>
        <nav aria-label="Accès rapides" className="dd-mods">
          {links.map((item) => (
            <Link key={item.href} href={item.href} className="dd-mod">
              <strong>{item.label} ↗</strong>
              <span>{DESCRIPTIONS[item.href] ?? 'Accéder au module.'}</span>
            </Link>
          ))}
        </nav>
      </section>
    </div>
  );
}

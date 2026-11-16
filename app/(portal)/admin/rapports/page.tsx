import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { PageLoading } from '@/components/portal/PageLoading';
import { BarChart, Donut } from '@/components/portal/dash/charts';
import '@/components/portal/dash/dashboard.css';
import { requireAdmin } from '@/lib/portal/guards';
import { formatMoney } from '@/lib/pricing';
import { getServerContext } from '@/server/context';
import { MONTH_PATTERN, monthReport } from '@/server/finance/reports';
import { readOverview } from '@/server/inventory/stock';
import { algiersDateString } from '@/server/util/algiers';
import type { BreakdownRow } from '@/shared/finance';

export const metadata: Metadata = { title: 'Rapports — Darling', robots: { index: false } };

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shift = (m: string, by: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export default function ReportsPage(props: PageProps<'/admin/rapports'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

function Breakdown({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  return (
    <div className="dd-card">
      <div className="dd-h">
        <h2>{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="dd-empty">Aucune vente.</p>
      ) : (
        <table className="dd-table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Ventes</th>
              <th>Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {r.label} <small style={{ color: 'var(--muted)' }}>×{r.count}</small>
                </td>
                <td>{formatMoney(r.sales)}</td>
                <td className={r.profit >= 0 ? 'dd-pos' : 'dd-neg'}>{formatMoney(r.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

async function Content({ searchParams }: PageProps<'/admin/rapports'>) {
  await connection();
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('finance.read')) return <AccessDenied />;

  const ctx = getServerContext();
  const current = algiersDateString(ctx.clock.now()).slice(0, 7);
  const asked = typeof sp.month === 'string' ? sp.month : current;
  const month = MONTH_PATTERN.test(asked) ? asked : current;
  const r = monthReport(ctx.db, month);
  const missingCost = readOverview(ctx.db, { withCost: true }).filter((p) => p.isActive && (p.costPrice ?? 0) === 0);
  const days = r.daily.map((d) => ({ label: d.date, sales: d.sales, profit: d.profit }));
  const sales = r.realised.sales + r.pipeline.sales;

  return (
    <div className="dd">
      <header className="dd-h" style={{ alignItems: 'center' }}>
        <div>
          <p className="dd-card__label">Finance · réservé aux administrateurs</p>
          <h1 style={{ fontSize: 'clamp(26px,3vw,38px)', letterSpacing: '-.04em' }}>Rapport de {label(month)}</h1>
        </div>
        <div className="dd-month" aria-label="Choisir le mois">
          <Link href={`/admin/rapports?month=${shift(month, -1)}`}>← {label(shift(month, -1))}</Link>
          <span aria-current="true">{label(month)}</span>
          {month < current ? <Link href={`/admin/rapports?month=${shift(month, 1)}`}>{label(shift(month, 1))} →</Link> : null}
        </div>
      </header>

      {missingCost.length > 0 ? (
        <Link href="/admin/stock" className="dd-card dd-card--urgent" style={{ display: 'block' }}>
          <div className="dd-card__label">Profits incomplets</div>
          <div className="dd-card__sub" style={{ color: 'var(--ink)', fontSize: 14, marginTop: 6 }}>
            Prix d’achat manquant pour {missingCost.map((p) => p.name).join(', ')} : aucun coût n’est déduit. Renseignez-le dans Stock →
          </div>
        </Link>
      ) : null}

      <section className="dd-card" aria-label="Exporter">
        <div className="dd-h">
          <h2>Exporter en CSV</h2>
        </div>
        <div className="dd-actions" style={{ marginTop: 0 }}>
          <a className="dd-pill dd-pill--solid" style={{ background: 'var(--pink)', color: '#fff' }} href={`/api/reports/export?month=${month}&kind=orders`}>
            ⬇ Commandes + coûts + profits
          </a>
          <a className="dd-pill" style={{ background: 'var(--ink)' }} href={`/api/reports/export?month=${month}&kind=daily`}>
            ⬇ Totaux jour par jour
          </a>
        </div>
        <p className="dd-card__sub">Fichiers compatibles Excel (séparateur « ; »). Les ventes hors site sont incluses.</p>
      </section>

      <section className="dd-grid4" aria-label="Chiffres du mois">
        <div className="dd-card dd-card--good">
          <div className="dd-card__label">Profit encaissé</div>
          <div className="dd-card__val">{formatMoney(r.realised.profit)}</div>
          <div className="dd-card__sub">
            {r.realised.count} vente(s) livrée(s) ou hors site
          </div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Profit attendu</div>
          <div className="dd-card__val">{formatMoney(r.pipeline.profit)}</div>
          <div className="dd-card__sub">{r.pipeline.count} commande(s) en cours</div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Ventes produit</div>
          <div className="dd-card__val">{formatMoney(sales)}</div>
          <div className="dd-card__sub">Livraison non comptée</div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Coût réel</div>
          <div className="dd-card__val">{formatMoney(r.realised.cost + r.pipeline.cost)}</div>
          <div className="dd-card__sub">Prix d’achat des articles vendus</div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Commissions</div>
          <div className="dd-card__val">{formatMoney(r.realised.commissions + r.pipeline.commissions)}</div>
          <div className="dd-card__sub">Influenceuses et managers</div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Perdu</div>
          <div className="dd-card__val">{formatMoney(r.lost.sales)}</div>
          <div className="dd-card__sub">{r.lost.count} annulée(s), refusée(s) ou retournée(s)</div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Ventes hors site</div>
          <div className="dd-card__val">{r.offsite.units}<small>unités</small></div>
          <div className="dd-card__sub">{formatMoney(r.offsite.sales)} de ventes</div>
        </div>
        <div className="dd-card">
          <div className="dd-card__label">Taux de livraison</div>
          <div className="dd-card__val">{r.deliveryRate === null ? '—' : <>{r.deliveryRate}<small>%</small></>}</div>
          <div className="dd-card__sub">{r.orders} commande(s) créée(s)</div>
        </div>
      </section>

      <section className="dd-two">
        <div className="dd-card">
          <div className="dd-h">
            <h2>Jour par jour</h2>
          </div>
          <BarChart data={days} showProfit />
        </div>
        <div className="dd-card">
          <div className="dd-h">
            <h2>Canaux</h2>
          </div>
          <Donut data={r.bySource.map((s) => ({ label: s.label, value: s.sales }))} centre={formatMoney(sales)} />
        </div>
      </section>

      <section className="dd-two" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Breakdown title="Par produit" rows={r.byProduct} />
        <Breakdown title="Par canal" rows={r.bySource} />
      </section>
      <Breakdown title="Meilleures wilayas" rows={r.byWilaya} />
    </div>
  );
}

import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { USER_STATUSES, type AdminCommissionRow } from '@/shared';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { CopyField } from '@/components/portal/CopyField';
import { PayoutButton } from '@/components/portal/PayoutButton';
import { apiServer } from '@/lib/api/server';
import type { AffiliateDetail } from '@/server/commissions/queries';
import { commissionKindLabel, commissionStatusLabel, commissionStatusTone, formatSignedMoney, payoutMethodLabel } from '@/lib/portal/commissions';
import { formatDateTime, formatDay } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { statusLabel, statusTone } from '@/lib/portal/labels';
import { apiMessage } from '@/lib/portal/messages';
import { orderStatusLabel, orderStatusTone } from '@/lib/portal/orders';
import { formatMoney } from '@/lib/pricing';

export const metadata: Metadata = { title: 'Influenceuse — Darling', robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AffiliateDetailPage(props: PageProps<'/admin/influenceuses/[id]'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

const isDetail = (d: unknown): d is AffiliateDetail =>
  typeof d === 'object' && d !== null && typeof (d as AffiliateDetail).affiliate === 'object' && Array.isArray((d as AffiliateDetail).commissions);

async function Content({ params }: PageProps<'/admin/influenceuses/[id]'>) {
  const [me, { id }] = await Promise.all([requireAdmin(), params]);
  if (!me.permissions.includes('commissions.manage')) return <AccessDenied />;
  const back = (
    <Link className="p-back" href="/admin/influenceuses">
      ← Influenceuses
    </Link>
  );
  if (!UUID.test(id)) {
    return (
      <div className="p-stack">
        {back}
        <Notice tone="error">{apiMessage('not_found')}</Notice>
      </div>
    );
  }
  const result = await apiServer<unknown>(`/api/affiliates/${encodeURIComponent(id)}`);
  if (!result.ok || !isDetail(result.data)) {
    return (
      <div className="p-stack">
        {back}
        <Notice tone="error">{apiMessage(result.ok ? 'generic' : result.code)}</Notice>
      </div>
    );
  }
  const d = result.data;
  const a = d.affiliate;
  const canPay = me.permissions.includes('payouts.manage');
  const canSeeOrders = me.permissions.includes('orders.read');
  const money = (n: number) => <span className="p-money">{formatMoney(n)}</span>;

  return (
    <div className="p-stack p-stack--lg">
      {back}
      <PageHeader
        eyebrow="Influenceuse"
        title={a.name}
        actions={<Badge tone={statusTone(a.status as (typeof USER_STATUSES)[number])}>{statusLabel(a.status as (typeof USER_STATUSES)[number])}</Badge>}
      />

      <section className="p-card glass" aria-labelledby="f-info">
        <h2 className="p-card__title" id="f-info">
          Code et lien
        </h2>
        <dl className="p-dl">
          <div>
            <dt>Code</dt>
            <dd>
              <strong>{a.code}</strong>
            </dd>
          </div>
          <div>
            <dt>Sous-manager</dt>
            <dd>{a.manager?.name ?? 'Aucun'}</dd>
          </div>
          <div>
            <dt>Lien d’affiliation</dt>
            <dd>
              <CopyField label="Lien d’affiliation" value={a.link} />
            </dd>
          </div>
          <div>
            <dt>Fiche utilisateur</dt>
            <dd>{me.permissions.includes('users.manage') ? <Link className="p-linkbtn" href={`/admin/utilisateurs/${a.userId}`}>Ouvrir la fiche</Link> : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="p-stack" aria-labelledby="f-stats">
        <h2 className="p-section-title" id="f-stats">
          Activité
        </h2>
        <div className="p-stats">
          <div className="p-stat glass">
            <span className="p-stat__label">Clics</span>
            <span className="p-stat__value">{a.clicks}</span>
          </div>
          <div className="p-stat glass">
            <span className="p-stat__label">Commandes</span>
            <span className="p-stat__value">{a.orders}</span>
          </div>
          <div className="p-stat glass">
            <span className="p-stat__label">Livrées</span>
            <span className="p-stat__value">{a.delivered}</span>
          </div>
          <div className="p-stat glass">
            <span className="p-stat__label">En attente</span>
            <span className="p-stat__value">{formatMoney(a.totals.pending)}</span>
            {a.totals.onHold > 0 ? <span className="p-lead">dont {formatMoney(a.totals.onHold)} retenus</span> : null}
          </div>
          <div className="p-stat glass">
            <span className="p-stat__label">Validées</span>
            <span className="p-stat__value">{formatMoney(a.totals.validated)}</span>
          </div>
          <div className="p-stat glass">
            <span className="p-stat__label">Payées</span>
            <span className="p-stat__value">{formatMoney(a.totals.paid)}</span>
          </div>
        </div>
      </section>

      <section className="p-card glass" aria-labelledby="f-pay">
        <h2 className="p-card__title" id="f-pay">
          Paiement
        </h2>
        <p className="p-lead">
          À payer maintenant : <strong>{formatMoney(d.payable.amount)}</strong>
          {d.payable.adjustments !== 0 ? ` (après déduction des retours : ${formatSignedMoney(d.payable.adjustments)})` : ''}.
        </p>
        {canPay ? (
          <PayoutButton
            beneficiaryUserId={a.userId}
            name={a.name}
            amount={d.payable.amount}
            commissions={d.payable.commissions}
            adjustments={d.payable.adjustments}
            commissionCount={d.payable.commissionCount}
          />
        ) : (
          <Notice tone="info">Le paiement demande la permission « paiements de commissions ».</Notice>
        )}
      </section>

      <section className="p-stack" aria-labelledby="f-comm">
        <h2 className="p-section-title" id="f-comm">
          Commissions
        </h2>
        <Table<AdminCommissionRow>
          rows={d.commissions}
          empty="Aucune commission."
          columns={[
            { key: 'order', header: 'Commande', render: (c) => (canSeeOrders ? <Link className="p-linkbtn" href={`/admin/commandes/${c.orderId}`}>{c.orderNumber}</Link> : c.orderNumber) },
            { key: 'date', header: 'Date', hideBelow: 'sm', render: (c) => formatDay(c.orderDate) },
            { key: 'kind', header: 'Type', hideBelow: 'md', render: (c) => commissionKindLabel(c.kind) },
            { key: 'amount', header: 'Montant', render: (c) => money(c.amount) },
            { key: 'status', header: 'Statut', render: (c) => <Badge tone={commissionStatusTone(c.status)}>{commissionStatusLabel(c.status, c.onHold)}</Badge> },
          ]}
        />
        <p className="p-subtle">
          <Link className="p-linkbtn" href={`/admin/commissions?beneficiary=${a.userId}`}>
            Voir toutes les commissions
          </Link>
        </p>
      </section>

      <section className="p-stack" aria-labelledby="f-orders">
        <h2 className="p-section-title" id="f-orders">
          Commandes attribuées
        </h2>
        <Table
          rows={d.orders}
          empty="Aucune commande attribuée."
          columns={[
            { key: 'number', header: 'Numéro', render: (o) => (canSeeOrders ? <Link className="p-linkbtn" href={`/admin/commandes/${o.id}`}>{o.number}</Link> : o.number) },
            { key: 'date', header: 'Date', hideBelow: 'sm', render: (o) => formatDateTime(o.createdAt) },
            { key: 'customer', header: 'Cliente', render: (o) => o.customer || '—' },
            { key: 'total', header: 'Total', render: (o) => money(o.total) },
            { key: 'status', header: 'Statut', render: (o) => <Badge tone={orderStatusTone(o.status as Parameters<typeof orderStatusTone>[0])}>{orderStatusLabel(o.status as Parameters<typeof orderStatusLabel>[0])}</Badge> },
            { key: 'self', header: 'Auto-référence', hideBelow: 'md', render: (o) => (o.selfReferral ? 'Oui' : '—') },
          ]}
        />
      </section>

      <section className="p-stack" aria-labelledby="f-clicks">
        <h2 className="p-section-title" id="f-clicks">
          Derniers clics
        </h2>
        <Table
          rows={d.clicks}
          empty="Aucun clic enregistré."
          columns={[
            { key: 'at', header: 'Date', render: (k) => formatDateTime(k.at) },
            { key: 'from', header: 'Provenance', hideBelow: 'sm', render: (k) => k.referrerHost ?? '—' },
            { key: 'path', header: 'Page', hideBelow: 'sm', render: (k) => k.landingPath },
            { key: 'conv', header: 'Commande', render: (k) => (k.converted ? 'Oui' : '—') },
          ]}
        />
      </section>

      <section className="p-stack" aria-labelledby="f-payouts">
        <h2 className="p-section-title" id="f-payouts">
          Paiements reçus
        </h2>
        <Table
          rows={d.payouts}
          empty="Aucun paiement."
          columns={[
            { key: 'date', header: 'Date', render: (p) => formatDay(p.paidAt) },
            { key: 'amount', header: 'Montant', render: (p) => money(p.amount) },
            { key: 'method', header: 'Mode', render: (p) => payoutMethodLabel(p.method) },
            { key: 'ref', header: 'Référence', hideBelow: 'sm', render: (p) => p.reference ?? '—' },
          ]}
        />
      </section>
    </div>
  );
}

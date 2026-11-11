import { Badge, Notice, Table } from '@/ui';
import type { MaskedOrder, OwnAdjustment, OwnCommission, OwnPayout } from '@/shared';
import { commissionKindLabel, commissionStatusLabel, commissionStatusTone, formatSignedMoney, payoutMethodLabel } from '@/lib/portal/commissions';
import { formatDateTime, formatDay } from '@/lib/portal/format';
import { orderStatusLabel, orderStatusTone } from '@/lib/portal/orders';
import { formatMoney } from '@/lib/pricing';

// Read-only tables shared by the influenceuse and sous-manager portals. They only ever receive the masked shapes of the
// self-service APIs: a customer is "Prénom X.", and there is no phone, address or note anywhere in these types.

export function StatCards({ items }: { items: { label: string; value: string | number; hint?: string }[] }) {
  return (
    <div className="p-stats">
      {items.map((i) => (
        <div className="p-stat glass" key={i.label}>
          <span className="p-stat__label">{i.label}</span>
          <span className="p-stat__value">{i.value}</span>
          {i.hint ? <span className="p-lead">{i.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function MaskedOrdersTable({ orders, withAffiliate = false }: { orders: MaskedOrder[]; withAffiliate?: boolean }) {
  return (
    <Table<MaskedOrder>
      rows={orders}
      empty="Aucune commande pour le moment."
      columns={[
        { key: 'ref', header: 'Commande', render: (o) => o.ref },
        { key: 'date', header: 'Date', hideBelow: 'sm', render: (o) => formatDateTime(o.createdAt) },
        ...(withAffiliate ? [{ key: 'aff', header: 'Influenceuse', render: (o: MaskedOrder) => (o.affiliate ? `${o.affiliate.name} (${o.affiliate.code})` : '—') }] : []),
        { key: 'customer', header: 'Cliente', render: (o) => o.customer || '—' },
        { key: 'product', header: 'Produit', hideBelow: 'md', render: (o) => `${o.productName} × ${o.quantity}` },
        { key: 'wilaya', header: 'Wilaya', hideBelow: 'md', render: (o) => o.wilayaName },
        { key: 'total', header: 'Total', render: (o) => <span className="p-money">{formatMoney(o.total)}</span> },
        { key: 'status', header: 'Statut', render: (o) => <Badge tone={orderStatusTone(o.status as Parameters<typeof orderStatusTone>[0])}>{orderStatusLabel(o.status as Parameters<typeof orderStatusLabel>[0])}</Badge> },
      ]}
    />
  );
}

export function OwnCommissionsTable({ commissions }: { commissions: OwnCommission[] }) {
  return (
    <Table<OwnCommission>
      rows={commissions}
      empty="Aucune commission pour le moment."
      columns={[
        { key: 'order', header: 'Commande', render: (c) => c.orderRef },
        { key: 'date', header: 'Date', hideBelow: 'sm', render: (c) => formatDay(c.orderDate) },
        { key: 'kind', header: 'Type', hideBelow: 'md', render: (c) => commissionKindLabel(c.kind) },
        { key: 'amount', header: 'Montant', render: (c) => <span className="p-money">{formatMoney(c.amount)}</span> },
        { key: 'status', header: 'Statut', render: (c) => <Badge tone={commissionStatusTone(c.status)}>{commissionStatusLabel(c.status)}</Badge> },
      ]}
    />
  );
}

export function OwnPayoutsTable({ payouts }: { payouts: OwnPayout[] }) {
  return (
    <Table<OwnPayout>
      rows={payouts}
      empty="Aucun paiement reçu pour le moment."
      columns={[
        { key: 'date', header: 'Date', render: (p) => formatDay(p.paidAt) },
        { key: 'amount', header: 'Montant', render: (p) => <span className="p-money">{formatMoney(p.amount)}</span> },
        { key: 'method', header: 'Mode', render: (p) => payoutMethodLabel(p.method) },
        { key: 'ref', header: 'Référence', hideBelow: 'sm', render: (p) => p.reference ?? '—' },
      ]}
    />
  );
}

/** Returned orders whose commission was already paid are deducted from the next payment: say so plainly. */
export function AdjustmentsNotice({ adjustments, unsettled }: { adjustments: OwnAdjustment[]; unsettled: number }) {
  if (adjustments.length === 0) return null;
  return (
    <Notice tone="info">
      {unsettled < 0 ? (
        <>
          Une commande déjà payée a été retournée : <strong>{formatSignedMoney(unsettled)}</strong> seront déduits de votre prochain paiement.
        </>
      ) : (
        <>Les déductions liées aux retours ont déjà été prises en compte dans vos paiements.</>
      )}
      <ul className="p-list">
        {adjustments.map((a) => (
          <li key={a.id}>
            {formatDay(a.createdAt)} — {formatSignedMoney(a.amount)} {a.orderRef ? `(commande ${a.orderRef})` : ''} {a.settled ? '· déjà déduit' : '· à déduire'}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

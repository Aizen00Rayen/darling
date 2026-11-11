import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Notice, PageHeader } from '@/ui';
import type { OrderDetail } from '@/shared';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { OrderActions } from '@/components/portal/OrderActions';
import { OrderNotesForm } from '@/components/portal/OrderNotesForm';
import { apiServer } from '@/lib/api/server';
import { formatDateTime } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { apiMessage } from '@/lib/portal/messages';
import { deliveryModeLabel, formatPhone, orderSourceLabel, orderSourceTone, orderStatusLabel, orderStatusTone, shadeLabel } from '@/lib/portal/orders';
import { firstParam } from '@/lib/portal/query';
import { formatMoney } from '@/lib/pricing';

export const metadata: Metadata = { title: 'Commande — Darling', robots: { index: false } };

// Only ever put into an API path when it has the shape of a UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function OrderDetailPage(props: PageProps<'/admin/commandes/[id]'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

const isOrder = (data: unknown): data is OrderDetail =>
  typeof data === 'object' && data !== null && typeof (data as OrderDetail).id === 'string' && Array.isArray((data as OrderDetail).history);

async function Content({ params, searchParams }: PageProps<'/admin/commandes/[id]'>) {
  const [me, { id }, sp] = await Promise.all([requireAdmin(), params, searchParams]);
  if (!me.permissions.includes('orders.read')) return <AccessDenied />;
  const canWrite = me.permissions.includes('orders.write');

  const back = (
    <Link className="p-back" href="/admin/commandes">
      ← Commandes
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

  const result = await apiServer<unknown>(`/api/orders/${encodeURIComponent(id)}`);
  if (!result.ok || !isOrder(result.data)) {
    return (
      <div className="p-stack">
        {back}
        <Notice tone="error">{apiMessage(result.ok ? 'generic' : result.code)}</Notice>
      </div>
    );
  }
  const order = result.data;
  const created = firstParam(sp.created) === '1';

  return (
    <div className="p-stack p-stack--lg">
      {back}
      <PageHeader
        eyebrow="Commande"
        title={order.number}
        actions={
          <>
            <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
            <Badge tone={orderSourceTone(order.source)}>{orderSourceLabel(order.source)}</Badge>
          </>
        }
      />
      {created ? <Notice tone="success">Commande enregistrée.</Notice> : null}

      <section className="p-card glass" aria-labelledby="o-customer">
        <h2 className="p-card__title" id="o-customer">
          Cliente
        </h2>
        <dl className="p-dl">
          <div>
            <dt>Nom</dt>
            <dd>{order.customerName}</dd>
          </div>
          <div>
            <dt>Téléphone</dt>
            <dd>{formatPhone(order.phone)}</dd>
          </div>
          <div>
            <dt>Wilaya</dt>
            <dd>
              {String(order.wilayaCode).padStart(2, '0')} — {order.wilayaName}
            </dd>
          </div>
          <div>
            <dt>Commune</dt>
            <dd>{order.commune}</dd>
          </div>
          <div>
            <dt>Livraison</dt>
            <dd>{deliveryModeLabel(order.deliveryMode)}</dd>
          </div>
          <div>
            <dt>Adresse</dt>
            <dd>{order.address ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="p-card glass" aria-labelledby="o-order">
        <h2 className="p-card__title" id="o-order">
          Commande
        </h2>
        <dl className="p-dl">
          <div>
            <dt>Produit</dt>
            <dd>{order.productName}</dd>
          </div>
          <div>
            <dt>Teinte</dt>
            <dd>{shadeLabel(order.shadeCode)}</dd>
          </div>
          <div>
            <dt>Quantité</dt>
            <dd>{order.quantity}</dd>
          </div>
          <div>
            <dt>Prix unitaire</dt>
            <dd>{formatMoney(order.unitPrice)}</dd>
          </div>
          <div>
            <dt>Frais de livraison</dt>
            <dd>{formatMoney(order.deliveryFee)}</dd>
          </div>
          <div>
            <dt>Total à encaisser</dt>
            <dd>
              <strong>{formatMoney(order.total)}</strong>
            </dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd>{orderSourceLabel(order.source)}</dd>
          </div>
          <div>
            <dt>Saisie par</dt>
            <dd>{order.createdBy ? order.createdBy.fullName : 'Site web'}</dd>
          </div>
          <div>
            <dt>Créée le</dt>
            <dd>{formatDateTime(order.createdAt)}</dd>
          </div>
          <div>
            <dt>Dernière modification</dt>
            <dd>{formatDateTime(order.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="p-card glass" aria-labelledby="o-actions">
        <h2 className="p-card__title" id="o-actions">
          Statut
        </h2>
        {canWrite ? (
          <OrderActions orderId={order.id} status={order.status} />
        ) : (
          <Notice tone="info">Vous pouvez consulter cette commande mais pas la modifier.</Notice>
        )}
        <h3 className="p-section-title">Historique</h3>
        <ol className="p-timeline" aria-label="Historique des statuts">
          {order.history.map((h) => (
            <li key={h.id}>
              <span>
                <Badge tone={orderStatusTone(h.toStatus)}>{orderStatusLabel(h.toStatus)}</Badge>
              </span>
              <span className="p-timeline__when">
                {formatDateTime(h.at)} · {h.actor ? h.actor.fullName : h.fromStatus === null ? 'Client (site web)' : 'Système'}
              </span>
              {h.note ? <span className="p-timeline__note">{h.note}</span> : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="p-card glass" aria-labelledby="o-notes">
        <h2 className="p-card__title" id="o-notes">
          Notes internes
        </h2>
        {canWrite ? (
          <OrderNotesForm orderId={order.id} notes={order.internalNotes} />
        ) : (
          <p className="p-notes">{order.internalNotes ?? 'Aucune note.'}</p>
        )}
      </section>
    </div>
  );
}

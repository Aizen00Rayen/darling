import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { COMMISSION_STATUSES, type AdminCommissionRow, type AdminPayoutRow, type CommissionTotals } from '@/shared';
import { AccessDenied } from '@/components/portal/AccessDenied';
import { CommissionActions } from '@/components/portal/CommissionActions';
import { Pager } from '@/components/portal/Pager';
import { PayoutButton } from '@/components/portal/PayoutButton';
import { apiServer } from '@/lib/api/server';
import { commissionKindLabel, commissionStatusLabel, commissionStatusTone, formatSignedMoney, payoutMethodLabel } from '@/lib/portal/commissions';
import { formatDay } from '@/lib/portal/format';
import { requireAdmin } from '@/lib/portal/guards';
import { firstError, isList } from '@/lib/portal/lists';
import { apiMessage } from '@/lib/portal/messages';
import { buildHref, firstParam, parsePage } from '@/lib/portal/query';
import { formatMoney } from '@/lib/pricing';
import { getServerContext } from '@/server/context';
import { listBeneficiaries } from '@/server/commissions/queries';

export const metadata: Metadata = { title: 'Commissions — Darling', robots: { index: false } };

const PAGE_SIZE = 50;
const BASE = '/admin/commissions';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Payable {
  userId: string;
  name: string;
  role: string;
  commissionCount: number;
  commissions: number;
  adjustments: number;
  amount: number;
}

export default function CommissionsPage(props: PageProps<'/admin/commissions'>) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content {...props} />
    </Suspense>
  );
}

async function Content({ searchParams }: PageProps<'/admin/commissions'>) {
  const [me, sp] = await Promise.all([requireAdmin(), searchParams]);
  if (!me.permissions.includes('commissions.manage')) return <AccessDenied />;
  const canPay = me.permissions.includes('payouts.manage');
  const tab = firstParam(sp.vue) === 'versements' ? 'versements' : 'commissions';

  return (
    <div className="p-stack">
      <PageHeader eyebrow="Administration" title="Commissions" />
      <nav className="p-tabs" aria-label="Vues">
        <Link className="p-tab" href={BASE} aria-current={tab === 'commissions' ? 'page' : undefined}>
          Commissions
        </Link>
        <Link className="p-tab" href={`${BASE}?vue=versements`} aria-current={tab === 'versements' ? 'page' : undefined}>
          Versements
        </Link>
      </nav>
      {tab === 'versements' ? canPay ? <PayoutsTab sp={sp} /> : <Notice tone="error">Vous n’avez pas la permission de consulter les paiements.</Notice> : <CommissionsTab sp={sp} canPay={canPay} canSeeOrders={me.permissions.includes('orders.read')} />}
    </div>
  );
}

type Sp = Record<string, string | string[] | undefined>;

async function CommissionsTab({ sp, canPay, canSeeOrders }: { sp: Sp; canPay: boolean; canSeeOrders: boolean }) {
  await connection();
  const status = COMMISSION_STATUSES.find((s) => s === firstParam(sp.status));
  const beneficiaryParam = firstParam(sp.beneficiary);
  const beneficiary = beneficiaryParam && UUID.test(beneficiaryParam) ? beneficiaryParam : undefined;
  const order = firstParam(sp.order)?.slice(0, 30);
  const page = parsePage(sp.page);
  const filters = { status, beneficiary, order };
  const beneficiaries = listBeneficiaries(getServerContext().db);

  const [list, payable] = await Promise.all([
    apiServer<unknown>(buildHref('/api/commissions', { ...filters, page })),
    canPay ? apiServer<unknown>('/api/payouts/payable') : Promise.resolve(null),
  ]);
  const payables = payable?.ok && typeof payable.data === 'object' && payable.data !== null && Array.isArray((payable.data as { items?: unknown }).items) ? ((payable.data as { items: Payable[] }).items) : [];
  const money = (n: number) => <span className="p-money">{formatMoney(n)}</span>;

  return (
    <>
      {canPay ? (
        <section className="p-stack" aria-labelledby="c-topay">
          <h2 className="p-section-title" id="c-topay">
            À payer
          </h2>
          <Table<Payable>
            rows={payables}
            empty="Rien à payer pour le moment : les commissions deviennent payables une fois la commande livrée."
            columns={[
              { key: 'name', header: 'Bénéficiaire', render: (p) => (p.role === 'affiliate' ? <Link className="p-linkbtn" href={`/admin/influenceuses/${p.userId}`}>{p.name}</Link> : p.name) },
              { key: 'role', header: 'Rôle', hideBelow: 'sm', render: (p) => (p.role === 'affiliate' ? 'Influenceuse' : 'Sous-manager') },
              { key: 'n', header: 'Commissions', hideBelow: 'sm', render: (p) => p.commissionCount },
              { key: 'adj', header: 'Déductions', hideBelow: 'md', render: (p) => (p.adjustments === 0 ? '—' : <span className="p-money p-money--neg">{formatSignedMoney(p.adjustments)}</span>) },
              { key: 'amount', header: 'À payer', render: (p) => <strong className="p-money">{formatMoney(p.amount)}</strong> },
              { key: 'pay', header: 'Action', render: (p) => <PayoutButton beneficiaryUserId={p.userId} name={p.name} amount={p.amount} commissions={p.commissions} adjustments={p.adjustments} commissionCount={p.commissionCount} /> },
            ]}
          />
        </section>
      ) : null}

      <form className="p-filters glass" method="get" action={BASE} role="search" aria-label="Filtrer les commissions">
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="c-status">
            Statut
          </label>
          <select id="c-status" name="status" defaultValue={status ?? ''}>
            <option value="">Tous les statuts</option>
            {COMMISSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {commissionStatusLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="c-beneficiary">
            Bénéficiaire
          </label>
          <select id="c-beneficiary" name="beneficiary" defaultValue={beneficiary ?? ''}>
            <option value="">Tous les bénéficiaires</option>
            {beneficiaries.map((b) => (
              <option key={b.userId} value={b.userId}>
                {b.name} ({b.role === 'affiliate' ? 'influenceuse' : 'sous-manager'})
              </option>
            ))}
          </select>
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="c-order">
            Numéro de commande
          </label>
          <input id="c-order" type="search" name="order" defaultValue={order ?? ''} placeholder="DL-26-000123" maxLength={30} />
        </div>
        <div className="p-filters__actions">
          <button type="submit" className="dl-btn dl-btn--primary">
            Filtrer
          </button>
          <Link className="dl-btn dl-btn--ghost" href={BASE}>
            Réinitialiser
          </Link>
        </div>
      </form>

      {!list.ok ? (
        <Notice tone="error">{firstError(list, apiMessage(list.code))}</Notice>
      ) : !isList<AdminCommissionRow>(list.data) ? (
        <Notice tone="error">{apiMessage('generic')}</Notice>
      ) : (
        <>
          <Totals totals={(list.data as unknown as { totals: CommissionTotals }).totals} />
          <Table<AdminCommissionRow>
            rows={list.data.items}
            empty="Aucune commission ne correspond à ces critères."
            columns={[
              { key: 'order', header: 'Commande', render: (c) => (canSeeOrders ? <Link className="p-linkbtn" href={`/admin/commandes/${c.orderId}`}>{c.orderNumber}</Link> : c.orderNumber) },
              { key: 'date', header: 'Date', hideBelow: 'sm', render: (c) => formatDay(c.orderDate) },
              { key: 'customer', header: 'Cliente', hideBelow: 'md', render: (c) => c.customer || '—' },
              { key: 'who', header: 'Bénéficiaire', render: (c) => c.beneficiary.name },
              { key: 'kind', header: 'Type', hideBelow: 'md', render: (c) => commissionKindLabel(c.kind) },
              { key: 'amount', header: 'Montant', render: (c) => money(c.amount) },
              {
                key: 'status',
                header: 'Statut',
                render: (c) => (
                  <>
                    <Badge tone={commissionStatusTone(c.status)}>{commissionStatusLabel(c.status, c.onHold)}</Badge>
                    {c.status === 'cancelled' && c.cancelReason ? <span className="p-subtle"> {c.cancelReason}</span> : null}
                  </>
                ),
              },
              { key: 'actions', header: 'Actions', render: (c) => <CommissionActions id={c.id} status={c.status} onHold={c.onHold} /> },
            ]}
          />
          <Pager page={page} total={list.data.total} pageSize={PAGE_SIZE} hrefFor={(p) => buildHref(BASE, { ...filters, page: p })} />
        </>
      )}
    </>
  );
}

function Totals({ totals }: { totals: CommissionTotals }) {
  return (
    <div className="p-stats" aria-label="Totaux pour ces critères">
      <div className="p-stat glass">
        <span className="p-stat__label">En attente</span>
        <span className="p-stat__value">{formatMoney(totals.pending)}</span>
        {totals.onHold > 0 ? <span className="p-lead">dont {formatMoney(totals.onHold)} retenus</span> : null}
      </div>
      <div className="p-stat glass">
        <span className="p-stat__label">Validées</span>
        <span className="p-stat__value">{formatMoney(totals.validated)}</span>
      </div>
      <div className="p-stat glass">
        <span className="p-stat__label">Payées</span>
        <span className="p-stat__value">{formatMoney(totals.paid)}</span>
      </div>
      <div className="p-stat glass">
        <span className="p-stat__label">Annulées</span>
        <span className="p-stat__value">{formatMoney(totals.cancelled)}</span>
      </div>
    </div>
  );
}

async function PayoutsTab({ sp }: { sp: Sp }) {
  await connection();
  const dayOf = (v: string | string[] | undefined) => {
    const d = firstParam(v);
    return d && DAY.test(d) ? d : undefined;
  };
  const from = dayOf(sp.from);
  const to = dayOf(sp.to);
  const page = parsePage(sp.page);
  const result = await apiServer<unknown>(buildHref('/api/payouts', { from, to, page }));
  const filters = { vue: 'versements', from, to };
  return (
    <>
      <form className="p-filters glass" method="get" action={BASE} role="search" aria-label="Filtrer les versements">
        <input type="hidden" name="vue" value="versements" />
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="v-from">
            Du
          </label>
          <input id="v-from" type="date" name="from" defaultValue={from ?? ''} />
        </div>
        <div className="dl-field">
          <label className="dl-field__label" htmlFor="v-to">
            Au
          </label>
          <input id="v-to" type="date" name="to" defaultValue={to ?? ''} />
        </div>
        <div className="p-filters__actions">
          <button type="submit" className="dl-btn dl-btn--primary">
            Filtrer
          </button>
          <Link className="dl-btn dl-btn--ghost" href={`${BASE}?vue=versements`}>
            Réinitialiser
          </Link>
        </div>
      </form>
      {!result.ok ? (
        <Notice tone="error">{firstError(result, apiMessage(result.code))}</Notice>
      ) : !isList<AdminPayoutRow>(result.data) ? (
        <Notice tone="error">{apiMessage('generic')}</Notice>
      ) : (
        <>
          <Table<AdminPayoutRow>
            rows={result.data.items}
            empty="Aucun paiement enregistré."
            columns={[
              { key: 'date', header: 'Date', render: (p) => formatDay(p.paidAt) },
              { key: 'who', header: 'Bénéficiaire', render: (p) => p.beneficiary.name },
              { key: 'amount', header: 'Montant', render: (p) => <span className="p-money">{formatMoney(p.amount)}</span> },
              { key: 'method', header: 'Mode', hideBelow: 'sm', render: (p) => payoutMethodLabel(p.method) },
              { key: 'ref', header: 'Référence', hideBelow: 'sm', render: (p) => p.reference ?? '—' },
              { key: 'n', header: 'Commissions', hideBelow: 'md', render: (p) => p.commissionCount },
              { key: 'by', header: 'Enregistré par', hideBelow: 'md', render: (p) => p.createdBy ?? '—' },
            ]}
          />
          <Pager page={page} total={result.data.total} pageSize={PAGE_SIZE} hrefFor={(p) => buildHref(BASE, { ...filters, page: p })} />
        </>
      )}
    </>
  );
}

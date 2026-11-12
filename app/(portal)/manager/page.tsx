import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import { Badge, Notice, PageHeader, Table } from '@/ui';
import { USER_STATUSES, type MeTeam, type TeamMember } from '@/shared';
import { AdjustmentsNotice, MaskedOrdersTable, OwnCommissionsTable, OwnPayoutsTable, StatCards } from '@/components/portal/SelfService';
import { apiServer } from '@/lib/api/server';
import { requireManager } from '@/lib/portal/guards';
import { statusLabel, statusTone } from '@/lib/portal/labels';
import { apiMessage } from '@/lib/portal/messages';
import { firstName } from '@/lib/portal/names';
import { formatMoney } from '@/lib/pricing';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

export default function ManagerHome() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

const isTeam = (d: unknown): d is MeTeam => typeof d === 'object' && d !== null && Array.isArray((d as MeTeam).members) && Array.isArray((d as MeTeam).orders);

async function Content() {
  const me = await requireManager();
  const result = await apiServer<unknown>('/api/me/team');
  const header = <PageHeader eyebrow="Sous-manager" title={`Bonjour, ${firstName(me.fullName)}`} />;
  if (!result.ok || !isTeam(result.data)) {
    return (
      <div className="p-stack p-stack--lg">
        {header}
        <Notice tone="error">{apiMessage(result.ok ? 'generic' : result.code)}</Notice>
      </div>
    );
  }
  const d = result.data;
  const teamDelivered = d.members.reduce((n, m) => n + m.deliveredCount, 0);
  return (
    <div className="p-stack p-stack--lg">
      {header}
      <p className="p-lead">Le suivi de votre équipe d’influenceuses et vos propres commissions (par article livré par votre équipe).</p>

      <section className="p-stack" aria-labelledby="m-stats">
        <h2 className="p-section-title" id="m-stats">
          Votre équipe
        </h2>
        <StatCards
          items={[
            { label: 'Influenceuses', value: d.members.length },
            { label: 'Commandes de l’équipe', value: d.orderCount },
            { label: 'Livrées', value: teamDelivered },
            { label: 'Vos commissions en attente', value: formatMoney(d.totals.pending) },
            { label: 'Vos commissions validées', value: formatMoney(d.totals.validated), hint: 'À payer par Darling' },
            { label: 'Vos commissions payées', value: formatMoney(d.totals.paid) },
          ]}
        />
        <AdjustmentsNotice adjustments={d.adjustments} unsettled={d.unsettledAdjustments} />
        <Table<TeamMember>
          rows={d.members}
          empty="Aucune influenceuse dans votre équipe pour le moment."
          columns={[
            { key: 'name', header: 'Influenceuse', render: (m) => m.name },
            { key: 'code', header: 'Code', render: (m) => <strong>{m.code}</strong> },
            { key: 'status', header: 'Compte', hideBelow: 'sm', render: (m) => <Badge tone={statusTone(m.status as (typeof USER_STATUSES)[number])}>{statusLabel(m.status as (typeof USER_STATUSES)[number])}</Badge> },
            { key: 'clicks', header: 'Clics', render: (m) => m.clicks },
            { key: 'orders', header: 'Commandes', render: (m) => m.orderCount },
            { key: 'delivered', header: 'Livrées', hideBelow: 'sm', render: (m) => m.deliveredCount },
            { key: 'pending', header: 'En attente', hideBelow: 'md', render: (m) => <span className="p-money">{formatMoney(m.totals.pending)}</span> },
            { key: 'validated', header: 'Validées', hideBelow: 'md', render: (m) => <span className="p-money">{formatMoney(m.totals.validated)}</span> },
            { key: 'paid', header: 'Payées', hideBelow: 'md', render: (m) => <span className="p-money">{formatMoney(m.totals.paid)}</span> },
          ]}
        />
      </section>

      <section className="p-stack" aria-labelledby="m-orders">
        <h2 className="p-section-title" id="m-orders">
          Commandes de l’équipe
        </h2>
        <MaskedOrdersTable orders={d.orders} withAffiliate />
        {d.orderCount > d.orders.length ? <p className="p-subtle">Les {d.orders.length} commandes les plus récentes sont affichées ({d.orderCount} au total).</p> : null}
      </section>

      <section className="p-stack" aria-labelledby="m-comm">
        <h2 className="p-section-title" id="m-comm">
          Vos commissions
        </h2>
        <OwnCommissionsTable commissions={d.commissions} />
      </section>

      <section className="p-stack" aria-labelledby="m-pay">
        <h2 className="p-section-title" id="m-pay">
          Paiements reçus
        </h2>
        <OwnPayoutsTable payouts={d.payouts} />
      </section>
    </div>
  );
}

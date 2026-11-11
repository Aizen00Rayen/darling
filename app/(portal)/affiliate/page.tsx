import { Suspense } from 'react';
import { PageLoading } from '@/components/portal/PageLoading';
import type { Metadata } from 'next';
import { Notice, PageHeader } from '@/ui';
import type { MeAffiliate } from '@/shared';
import { CopyField } from '@/components/portal/CopyField';
import { AdjustmentsNotice, MaskedOrdersTable, OwnCommissionsTable, OwnPayoutsTable, StatCards } from '@/components/portal/SelfService';
import { apiServer } from '@/lib/api/server';
import { requireAffiliate } from '@/lib/portal/guards';
import { apiMessage } from '@/lib/portal/messages';
import { firstName } from '@/lib/portal/names';
import { formatMoney } from '@/lib/pricing';

export const metadata: Metadata = { title: 'Tableau de bord — Darling', robots: { index: false } };

export default function AffiliateHome() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Content />
    </Suspense>
  );
}

const isMine = (d: unknown): d is MeAffiliate => typeof d === 'object' && d !== null && typeof (d as MeAffiliate).code === 'string' && Array.isArray((d as MeAffiliate).orders);

async function Content() {
  const me = await requireAffiliate();
  const result = await apiServer<unknown>('/api/me/affiliate');
  const header = <PageHeader eyebrow="Influenceuse" title={`Bonjour, ${firstName(me.fullName)}`} />;
  if (!result.ok || !isMine(result.data)) {
    return (
      <div className="p-stack p-stack--lg">
        {header}
        <Notice tone="info">
          {result.ok || result.code === 'not_found' ? 'Votre lien d’affiliation n’est pas encore prêt : contactez l’équipe Darling.' : apiMessage(result.code)}
        </Notice>
      </div>
    );
  }
  const d = result.data;
  return (
    <div className="p-stack p-stack--lg">
      {header}
      <p className="p-lead">Voici votre activité d’affiliation. Les commissions sont validées quand la commande est livrée, puis payées par l’équipe Darling.</p>

      <section className="p-card glass" aria-labelledby="a-link">
        <h2 className="p-card__title" id="a-link">
          Votre lien
        </h2>
        <p className="p-lead">Partagez ce lien : une commande passée après un clic sur votre lien vous est attribuée pendant la durée d’attribution (30 jours par défaut).</p>
        <dl className="p-dl">
          <div>
            <dt>Votre code</dt>
            <dd>
              <CopyField label="Votre code" value={d.code} />
            </dd>
          </div>
          <div>
            <dt>Votre lien</dt>
            <dd>
              <CopyField label="Votre lien d’affiliation" value={d.link} />
            </dd>
          </div>
        </dl>
      </section>

      <section className="p-stack" aria-labelledby="a-stats">
        <h2 className="p-section-title" id="a-stats">
          Votre activité
        </h2>
        <StatCards
          items={[
            { label: 'Clics', value: d.clicks },
            { label: 'Commandes', value: d.orderCount },
            { label: 'Livrées', value: d.deliveredCount },
            { label: 'Commissions en attente', value: formatMoney(d.totals.pending), hint: 'Commandes pas encore livrées' },
            { label: 'Commissions validées', value: formatMoney(d.totals.validated), hint: 'À payer par Darling' },
            { label: 'Commissions payées', value: formatMoney(d.totals.paid) },
          ]}
        />
        <AdjustmentsNotice adjustments={d.adjustments} unsettled={d.unsettledAdjustments} />
      </section>

      <section className="p-stack" aria-labelledby="a-orders">
        <h2 className="p-section-title" id="a-orders">
          Vos commandes
        </h2>
        <MaskedOrdersTable orders={d.orders} />
        {d.orderCount > d.orders.length ? <p className="p-subtle">Les {d.orders.length} commandes les plus récentes sont affichées ({d.orderCount} au total).</p> : null}
      </section>

      <section className="p-stack" aria-labelledby="a-comm">
        <h2 className="p-section-title" id="a-comm">
          Vos commissions
        </h2>
        <OwnCommissionsTable commissions={d.commissions} />
      </section>

      <section className="p-stack" aria-labelledby="a-pay">
        <h2 className="p-section-title" id="a-pay">
          Paiements reçus
        </h2>
        <OwnPayoutsTable payouts={d.payouts} />
        <p className="p-subtle">Total reçu : {formatMoney(d.paidTotal)}</p>
      </section>
    </div>
  );
}

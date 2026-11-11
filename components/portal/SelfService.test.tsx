import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MaskedOrder, OwnAdjustment } from '@/shared';
import { AdjustmentsNotice, MaskedOrdersTable, OwnCommissionsTable, OwnPayoutsTable, StatCards } from './SelfService';

const order: MaskedOrder = { ref: '#1', createdAt: '2026-11-11T10:00:00.000Z', status: 'delivered', productName: 'Wet Kiss', quantity: 2, total: 6300, wilayaName: 'Alger', customer: 'Amel B.' };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

describe('self-service tables', () => {
  it('shows the masked customer, French status and every column the brief asks for', () => {
    const html = renderToStaticMarkup(<MaskedOrdersTable orders={[order]} />);
    const t = text(html);
    for (const part of ['#1', 'Amel B.', 'Wet Kiss × 2', 'Alger', '6 300 DA', 'Livrée']) expect(t).toContain(part);
    expect(html).toContain('dl-table'); // cards below 700 px come from the shared Table
  });

  it('shows the influenceuse of each order for a sous-manager', () => {
    const html = renderToStaticMarkup(<MaskedOrdersTable withAffiliate orders={[{ ...order, affiliate: { code: 'AYA001', name: 'Aya Benali' } }]} />);
    expect(text(html)).toContain('Aya Benali (AYA001)');
  });

  it('renders commissions, payouts and the empty states in French', () => {
    expect(text(renderToStaticMarkup(<OwnCommissionsTable commissions={[]} />))).toContain('Aucune commission');
    expect(text(renderToStaticMarkup(<OwnPayoutsTable payouts={[]} />))).toContain('Aucun paiement reçu');
    const t = text(renderToStaticMarkup(<OwnCommissionsTable commissions={[{ id: 'c', orderRef: '#1', orderDate: '2026-11-11T10:00:00.000Z', kind: 'affiliate', amount: 300, status: 'validated' }]} />));
    expect(t).toContain('300 DA');
    expect(t).toContain('Validée');
    const p = text(renderToStaticMarkup(<OwnPayoutsTable payouts={[{ id: 'p', amount: 300, method: 'baridimob', reference: 'BM-1', paidAt: '2026-11-11T00:00:00.000Z' }]} />));
    expect(p).toContain('BaridiMob');
    expect(p).toContain('BM-1');
  });

  it('explains an unsettled clawback, and says nothing without adjustments', () => {
    const adj: OwnAdjustment = { id: 'j', amount: -300, reason: 'retour', orderRef: '#1', createdAt: '2026-11-11T10:00:00.000Z', settled: false };
    expect(text(renderToStaticMarkup(<AdjustmentsNotice adjustments={[adj]} unsettled={-300} />))).toMatch(/−300 DA seront déduits de votre prochain paiement/);
    expect(text(renderToStaticMarkup(<AdjustmentsNotice adjustments={[{ ...adj, settled: true }]} unsettled={0} />))).toContain('déjà été prises en compte');
    expect(renderToStaticMarkup(<AdjustmentsNotice adjustments={[]} unsettled={0} />)).toBe('');
  });

  it('renders the stat cards with hints', () => {
    const t = text(renderToStaticMarkup(<StatCards items={[{ label: 'Clics', value: 12, hint: 'au total' }]} />));
    expect(t).toContain('Clics');
    expect(t).toContain('12');
    expect(t).toContain('au total');
  });
});

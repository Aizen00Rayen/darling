// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const api = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: (...a: unknown[]) => api(...a) }));

import { algiersToday } from '@/lib/portal/commissions';
import { PayoutButton } from './PayoutButton';

beforeEach(() => {
  api.mockReset();
  refresh.mockReset();
  api.mockResolvedValue({ ok: true, data: { amount: 500 } });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const props = { beneficiaryUserId: 'u1', name: 'Aya Benali', amount: 500, commissions: 600, adjustments: -100, commissionCount: 2 };
const nbsp = (s: string) => s.replace(/[  ]/g, ' ');

describe('PayoutButton', () => {
  it('is disabled when there is nothing to pay', () => {
    render(<PayoutButton {...props} amount={0} commissions={0} commissionCount={0} adjustments={0} />);
    expect((screen.getByRole('button', { name: 'Payer Aya Benali' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the amount and its breakdown, with method, reference and today\'s date as inputs', async () => {
    const user = userEvent.setup();
    render(<PayoutButton {...props} />);
    await user.click(screen.getByRole('button', { name: 'Payer Aya Benali' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    const text = nbsp(dialog.textContent ?? '');
    expect(text).toContain('Montant à payer');
    expect(text).toContain('500 DA');
    expect(text).toContain('2 commissions validées (600 DA)');
    expect(text).toContain('déductions : −100 DA');
    expect((screen.getByLabelText('Date du paiement') as HTMLInputElement).value).toBe(algiersToday());
    expect([...(screen.getByLabelText('Mode de paiement') as HTMLSelectElement).options].map((o) => o.text)).toEqual(['Espèces', 'CCP', 'BaridiMob', 'Virement bancaire', 'Autre']);
  });

  it('sends one request with the chosen fields, then refreshes', async () => {
    const user = userEvent.setup();
    render(<PayoutButton {...props} />);
    await user.click(screen.getByRole('button', { name: 'Payer Aya Benali' }));
    await user.selectOptions(screen.getByLabelText('Mode de paiement'), 'baridimob');
    await user.type(screen.getByLabelText('Référence (facultatif)'), '  BM-77 ');
    await user.click(screen.getAllByRole('button').find((b) => /^Payer 500/.test(nbsp(b.textContent ?? '')))!);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith('/api/payouts', { method: 'POST', body: { beneficiaryUserId: 'u1', method: 'baridimob', paidAt: algiersToday(), reference: 'BM-77' } });
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText(/Paiement de 500.DA enregistré/)).toBeTruthy();
  });

  it('refuses a future date locally and shows the server\'s nothing_to_pay in French', async () => {
    const user = userEvent.setup();
    render(<PayoutButton {...props} />);
    await user.click(screen.getByRole('button', { name: 'Payer Aya Benali' }));
    const date = screen.getByLabelText('Date du paiement');
    await user.clear(date);
    await user.type(date, '2999-01-01');
    await user.click(screen.getAllByRole('button').find((b) => /^Payer 500/.test(nbsp(b.textContent ?? '')))!);
    expect(await screen.findByText('La date ne peut pas être dans le futur.')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();

    api.mockResolvedValue({ ok: false, status: 409, code: 'nothing_to_pay' });
    await user.clear(date);
    await user.type(date, algiersToday());
    await user.click(screen.getAllByRole('button').find((b) => /^Payer 500/.test(nbsp(b.textContent ?? '')))!);
    expect(await screen.findByText(/Rien à payer/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });
});

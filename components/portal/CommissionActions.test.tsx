// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const api = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: (...a: unknown[]) => api(...a) }));

import { CommissionActions } from './CommissionActions';

beforeEach(() => {
  api.mockReset();
  refresh.mockReset();
  api.mockResolvedValue({ ok: true, data: { status: 'cancelled' } });
  // jsdom has no <dialog> modal support
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const names = () => screen.queryAllByRole('button').map((b) => b.textContent);

describe('CommissionActions', () => {
  it.each([
    ['pending', false, ['Annuler']],
    ['pending', true, ['Libérer', 'Annuler']],
    ['validated', false, ['Annuler']],
    ['paid', false, []],
    ['cancelled', false, []],
    ['cancelled', true, []],
  ])('%s (held: %s) offers %j', (status, onHold, expected) => {
    render(<CommissionActions id="c1" status={status} onHold={onHold} />);
    expect(names()).toEqual(expected);
  });

  it('releases after confirmation and refreshes', async () => {
    const user = userEvent.setup();
    render(<CommissionActions id="c1" status="pending" onHold />);
    await user.click(screen.getByRole('button', { name: 'Libérer' }));
    await user.click(screen.getAllByRole('button', { name: 'Libérer' }).at(-1)!);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/commissions/c1/release-hold', { method: 'POST' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('refuses to cancel without a reason (no request), then sends the trimmed reason', async () => {
    const user = userEvent.setup();
    render(<CommissionActions id="c1" status="validated" onHold={false} />);
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await user.click(screen.getByRole('button', { name: 'Annuler la commission' }));
    expect(await screen.findByText('Indiquez le motif de l’annulation.')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Motif (obligatoire)'), '  Fraude  ');
    await user.click(screen.getByRole('button', { name: 'Annuler la commission' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/commissions/c1/cancel', { method: 'POST', body: { reason: 'Fraude' } }));
  });

  it('explains a conflict in French and refreshes (the commission changed under us)', async () => {
    api.mockResolvedValue({ ok: false, status: 409, code: 'commission_paid' });
    const user = userEvent.setup();
    render(<CommissionActions id="c1" status="validated" onHold={false} />);
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await user.type(screen.getByLabelText('Motif (obligatoire)'), 'x');
    await user.click(screen.getByRole('button', { name: 'Annuler la commission' }));
    expect(await screen.findByText(/déjà payée/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });
});

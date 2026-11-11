// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ORDER_STATUSES, nextStatuses, type OrderStatus } from '@/shared';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }) }));
const api = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: (...args: unknown[]) => api(...args) }));

import { orderActionFor } from '@/lib/portal/orders';
import { OrderActions } from './OrderActions';

const ID = '018f0000-0000-7000-8000-000000000001';

beforeEach(() => {
  api.mockReset();
  refresh.mockReset();
  api.mockResolvedValue({ ok: true, data: {} });
  // jsdom has no modal <dialog>
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('OrderActions', () => {
  it.each(ORDER_STATUSES)('offers exactly the legal next statuses of %s, nothing else', (status) => {
    render(<OrderActions orderId={ID} status={status as OrderStatus} />);
    for (const to of ORDER_STATUSES.filter((s) => s !== 'new')) {
      const button = screen.queryByRole('button', { name: orderActionFor(to).label });
      if (nextStatuses(status).includes(to)) expect(button, `${status} -> ${to}`).not.toBeNull();
      else expect(button, `${status} -> ${to}`).toBeNull();
    }
    if (nextStatuses(status).length === 0) expect(screen.getByText(/Cette commande est terminée/)).toBeTruthy();
  });

  it('posts the status change after confirmation and refreshes', async () => {
    const user = userEvent.setup();
    render(<OrderActions orderId={ID} status="new" />);
    await user.click(screen.getByRole('button', { name: 'Confirmer la commande' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/orders/${ID}/status`, { method: 'POST', body: { to: 'confirmed' } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('sends the optional note only for cancel, refuse and return', async () => {
    const user = userEvent.setup();
    render(<OrderActions orderId={ID} status="new" />);
    await user.click(screen.getByRole('button', { name: 'Annuler la commande' }));
    await user.type(screen.getByRole('textbox', { name: /Note/ }), '  injoignable  ');
    await user.click(screen.getAllByRole('button', { name: 'Annuler la commande' }).at(-1)!);
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/orders/${ID}/status`, { method: 'POST', body: { to: 'cancelled', note: 'injoignable' } }));
  });

  it('does not call the API when the dialog is dismissed', async () => {
    const user = userEvent.setup();
    render(<OrderActions orderId={ID} status="new" />);
    await user.click(screen.getByRole('button', { name: 'Confirmer la commande' }));
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(api).not.toHaveBeenCalled();
  });

  it('maps invalid_transition to the French message and refreshes to show the real status', async () => {
    api.mockResolvedValue({ ok: false, status: 409, code: 'invalid_transition' });
    const user = userEvent.setup();
    render(<OrderActions orderId={ID} status="new" />);
    await user.click(screen.getByRole('button', { name: 'Confirmer la commande' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Ce changement de statut n’est pas possible.');
    expect(refresh).toHaveBeenCalled();
  });

  it('maps other errors (forbidden, network) to French', async () => {
    api.mockResolvedValue({ ok: false, status: 403, code: 'forbidden' });
    const user = userEvent.setup();
    render(<OrderActions orderId={ID} status="confirmed" />);
    await user.click(screen.getByRole('button', { name: 'Marquer comme expédiée' }));
    await user.click(screen.getByRole('button', { name: 'Marquer expédiée' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission/);
  });
});

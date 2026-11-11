// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }) }));
const api = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: (...args: unknown[]) => api(...args) }));

import { OrderManualForm } from './OrderManualForm';

beforeEach(() => {
  push.mockReset();
  api.mockReset();
  api.mockResolvedValue({ ok: true, data: { id: 'new-order-id' } });
});
afterEach(cleanup);

const form = () => document.querySelector('form') as HTMLFormElement;
const nbsp = (s: string) => s.replace(/[  ]/g, ' ');
const totalText = () => nbsp(document.querySelector('.p-totals')!.textContent!);

describe('OrderManualForm', () => {
  it('is a POST form with noValidate (a native submit never puts the customer in the URL)', () => {
    render(<OrderManualForm />);
    expect(form().getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form().noValidate).toBe(true);
  });

  it('offers the manual sources only', () => {
    render(<OrderManualForm />);
    const options = Array.from((screen.getByLabelText('Provenance') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', 'instagram', 'whatsapp', 'facebook', 'direct', 'other']);
  });

  it('computes the total live with the shared pricing helpers', async () => {
    const user = userEvent.setup();
    render(<OrderManualForm />);
    expect(totalText()).toContain('Choisissez une wilaya');
    await user.selectOptions(screen.getByLabelText('Wilaya'), '16'); // Alger: desk 300, home 450, price 3300
    expect(totalText()).toContain('300 DA');
    expect(totalText()).toContain('3 600 DA');
    await user.clear(screen.getByLabelText('Quantité'));
    await user.type(screen.getByLabelText('Quantité'), '2');
    expect(totalText()).toContain('39 900 DA');
    await user.click(screen.getByLabelText('À domicile'));
    expect(totalText()).toContain('450 DA');
    expect(totalText()).toContain('40 050 DA');
  });

  it('disables Stop Desk where the wilaya has no desk service and forces home delivery', async () => {
    const user = userEvent.setup();
    render(<OrderManualForm />);
    await user.selectOptions(screen.getByLabelText('Wilaya'), '37'); // Tindouf: no desk
    const desk = screen.getByLabelText(/Stop Desk/) as HTMLInputElement;
    expect(desk.disabled).toBe(true);
    expect((screen.getByLabelText('À domicile') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText('Adresse de livraison')).toBeTruthy(); // address appears for home delivery
    expect(totalText()).toContain('1 650 DA');
  });

  it('shows local errors next to the fields and sends nothing when required fields are missing', async () => {
    const user = userEvent.setup();
    render(<OrderManualForm />);
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    expect(screen.getByText('Choisissez la provenance de la commande.')).toBeTruthy();
    expect(screen.getByText('Le nom est requis.')).toBeTruthy();
    expect(screen.getByText('Choisissez la wilaya.')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });

  it('posts the order through api() and opens the new order', async () => {
    const user = userEvent.setup();
    render(<OrderManualForm />);
    await user.selectOptions(screen.getByLabelText('Provenance'), 'whatsapp');
    await user.type(screen.getByLabelText('Nom et prénom'), '  Amel B ');
    await user.type(screen.getByLabelText('Téléphone'), '0612345678');
    await user.selectOptions(screen.getByLabelText('Wilaya'), '16');
    await user.type(screen.getByLabelText('Commune'), 'Hydra');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    const [path, init] = api.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
    expect(path).toBe('/api/orders/manual');
    expect(init.method).toBe('POST');
    expect(init.body).toMatchObject({ source: 'whatsapp', fullName: 'Amel B', phone: '0612345678', wilayaCode: 16, commune: 'Hydra', mode: 'desk', quantity: 1 });
    expect('address' in init.body).toBe(false);
    expect('total' in init.body).toBe(false); // prices are the server's business
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/commandes/new-order-id?created=1'));
  });

  it('maps server validation errors onto their fields and unknown codes to French', async () => {
    api.mockResolvedValueOnce({ ok: false, status: 400, code: 'validation', errors: { phone: 'Saisissez un numéro algérien valide.' } });
    const user = userEvent.setup();
    render(<OrderManualForm />);
    await user.selectOptions(screen.getByLabelText('Provenance'), 'direct');
    await user.type(screen.getByLabelText('Nom et prénom'), 'Amel B');
    await user.type(screen.getByLabelText('Téléphone'), '123');
    await user.selectOptions(screen.getByLabelText('Wilaya'), '16');
    await user.type(screen.getByLabelText('Commune'), 'Hydra');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    expect(await screen.findByText('Saisissez un numéro algérien valide.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    api.mockResolvedValueOnce({ ok: false, status: 403, code: 'forbidden' });
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/permission/);
  });
});

describe('OrderManualForm: influenceuse code', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(screen.getByLabelText('Provenance'), 'instagram');
    await user.type(screen.getByLabelText('Nom et prénom'), 'Amel Benali');
    await user.type(screen.getByLabelText('Téléphone'), '0550123456');
    await user.selectOptions(screen.getByLabelText('Wilaya'), '16');
    await user.type(screen.getByLabelText('Commune'), 'Hydra');
  }

  it('sends the code upper-cased when given, and nothing when blank', async () => {
    const user = userEvent.setup();
    render(<OrderManualForm />);
    await fill(user);
    await user.type(screen.getByLabelText('Code influenceuse (facultatif)'), 'aya001');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Enregistrer la commande' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api.mock.calls[0]![1].body.affiliateCode).toBe('AYA001');
    cleanup();
    api.mockClear();
    render(<OrderManualForm />);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect('affiliateCode' in api.mock.calls[0]![1].body).toBe(false);
  });

  it('shows the server\'s unknown-code message under the field', async () => {
    api.mockResolvedValue({ ok: false, status: 400, code: 'validation', errors: { affiliateCode: 'Code influenceuse inconnu ou inactif.' } });
    const user = userEvent.setup();
    render(<OrderManualForm />);
    await fill(user);
    await user.type(screen.getByLabelText('Code influenceuse (facultatif)'), 'ZZZ999');
    await user.click(screen.getByRole('button', { name: 'Enregistrer la commande' }));
    expect(await screen.findByText('Code influenceuse inconnu ou inactif.')).toBeTruthy();
  });
});

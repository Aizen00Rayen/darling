// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({ api: (...args: unknown[]) => api(...args) }));

import { SettingsForm } from './SettingsForm';

afterEach(() => {
  cleanup();
  api.mockReset();
});
const initial = {
  'security.require_2fa_super_managers': true,
  'company.name': 'DARLING*',
  'commission.affiliate_amount': 300,
  'commission.manager_amount': 200,
  'attribution.window_days': 30,
};

describe('SettingsForm', () => {
  it('locks every owner-only setting for a non-owner and explains why; the company name stays editable', () => {
    render(<SettingsForm initial={initial} isOwner={false} />);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('spinbutton', { name: 'Commission de l’influenceuse (DA)' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('spinbutton', { name: 'Commission du sous-manager (DA)' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('spinbutton', { name: 'Durée d’attribution (jours)' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText('Seul un propriétaire peut modifier ce réglage.')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: 'Enregistrer' })).toHaveLength(1);
  });

  it('lets an owner change them, with the French labels and the current values', () => {
    render(<SettingsForm initial={initial} isOwner />);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('spinbutton', { name: 'Commission de l’influenceuse (DA)' }) as HTMLInputElement).value).toBe('300');
    expect((screen.getByRole('spinbutton', { name: 'Commission du sous-manager (DA)' }) as HTMLInputElement).value).toBe('200');
    expect((screen.getByRole('spinbutton', { name: 'Durée d’attribution (jours)' }) as HTMLInputElement).value).toBe('30');
    expect(screen.queryByText('Seul un propriétaire peut modifier ce réglage.')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Enregistrer' })).toHaveLength(5);
  });

  it('sends a number (not text) and refuses non-integers before calling the API', async () => {
    api.mockResolvedValue({ ok: true, data: {} });
    const user = userEvent.setup();
    render(<SettingsForm initial={initial} isOwner />);
    const input = screen.getByRole('spinbutton', { name: 'Commission de l’influenceuse (DA)' });
    await user.clear(input);
    await user.type(input, '350');
    await user.click(screen.getAllByRole('button', { name: 'Enregistrer' })[2]!);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/settings/commission.affiliate_amount', { method: 'PATCH', body: { value: 350 } }));
    api.mockClear();
    await user.clear(input);
    await user.type(input, '3.5');
    await user.click(screen.getAllByRole('button', { name: 'Enregistrer' })[2]!);
    expect(await screen.findByText('Saisissez un nombre entier.')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });
});

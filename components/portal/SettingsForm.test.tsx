// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/api/client', () => ({ api: vi.fn() }));

import { SettingsForm } from './SettingsForm';

afterEach(cleanup);
const initial = { 'security.require_2fa_super_managers': true, 'company.name': 'DARLING*' };

describe('SettingsForm', () => {
  it('disables the 2FA toggle for a non-owner and explains why; the company name stays editable', () => {
    render(<SettingsForm initial={initial} isOwner={false} />);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Seul un propriétaire peut modifier ce réglage.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Enregistrer' })).toHaveLength(1);
  });

  it('lets an owner change it', () => {
    render(<SettingsForm initial={initial} isOwner />);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText('Seul un propriétaire peut modifier ce réglage.')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Enregistrer' })).toHaveLength(2);
  });
});

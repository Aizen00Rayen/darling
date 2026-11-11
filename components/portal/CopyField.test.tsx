// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyField } from './CopyField';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CopyField', () => {
  it('shows the value read-only and copies it, confirming with "Copié"', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<CopyField label="Lien d’affiliation" value="https://shop.example/?ref=AYA001" />);
    const input = screen.getByLabelText('Lien d’affiliation') as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('https://shop.example/?ref=AYA001');
    await user.click(screen.getByRole('button', { name: /Copier/ }));
    expect(writeText).toHaveBeenCalledWith('https://shop.example/?ref=AYA001');
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('Copié'));
  });

  it('tells the user to copy by hand when the clipboard is refused', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<CopyField label="Code" value="AYA001" />);
    await user.click(screen.getByRole('button'));
    expect(await screen.findByText(/Copie impossible/)).toBeTruthy();
  });
});

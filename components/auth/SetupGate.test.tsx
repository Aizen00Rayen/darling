// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next/server', () => ({ connection: async () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/api/client', () => ({ api: vi.fn() }));

import { createTestApp, seedUser, type TestApp } from '@/server/test/app';
import { SetupGate } from './SetupGate';

let app: TestApp;
afterEach(() => {
  cleanup();
  app?.close();
});

describe('SetupGate (the /configuration page)', () => {
  it('shows the setup form while no user exists and SETUP_TOKEN is set', async () => {
    app = createTestApp({ config: { setupToken: 'x'.repeat(40) } });
    render(await SetupGate());
    expect(screen.getByRole('heading', { name: 'Configuration initiale' })).toBeTruthy();
    expect(screen.getByLabelText('Jeton de configuration')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Créer le compte propriétaire' })).toBeTruthy();
    expect(document.querySelector('form')?.getAttribute('method')?.toLowerCase()).toBe('post');
  });

  it('redirects to /connexion once any user exists', async () => {
    app = createTestApp({ config: { setupToken: 'x'.repeat(40) } });
    await seedUser(app, { role: 'affiliate' });
    await expect(SetupGate()).rejects.toThrow('REDIRECT:/connexion');
  });

  it('redirects to /connexion when SETUP_TOKEN is not set', async () => {
    app = createTestApp();
    await expect(SetupGate()).rejects.toThrow('REDIRECT:/connexion');
  });

  it('redirects (and never throws) when the database cannot be read', async () => {
    app = createTestApp({ config: { setupToken: 'x'.repeat(40) } });
    app.db.get = () => {
      throw new Error('disk I/O error');
    };
    await expect(SetupGate()).rejects.toThrow('REDIRECT:/connexion');
  });
});

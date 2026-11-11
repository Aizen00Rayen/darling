// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const api = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: (...a: unknown[]) => api(...a) }));

import { RefCapture } from './RefCapture';

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ ok: true, data: undefined });
});
afterEach(cleanup);

function at(path: string) {
  window.history.replaceState(null, '', path);
}

describe('RefCapture', () => {
  it('renders nothing at all (the storefront looks the same)', () => {
    at('/');
    const { container } = render(<RefCapture />);
    expect(container.innerHTML).toBe('');
  });

  it('posts a valid code with the landing path, then removes ref and keeps the other parameters and the hash', async () => {
    at('/?ref=AYA001&utm_source=ig#order');
    render(<RefCapture />);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/affiliate/click', { method: 'POST', body: { code: 'AYA001', landingPath: '/', referrer: '' } });
    await vi.waitFor(() => expect(window.location.search).toBe('?utm_source=ig'));
    expect(window.location.hash).toBe('#order');
  });

  it('sends document.referrer, cut to 512 characters', () => {
    const real = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer')!;
    Object.defineProperty(document, 'referrer', { configurable: true, get: () => 'https://www.instagram.com/' + 'a'.repeat(700) });
    try {
      at('/?ref=AYA002');
      render(<RefCapture />);
      const body = api.mock.calls[0]![1].body;
      expect(body.referrer.startsWith('https://www.instagram.com/')).toBe(true);
      expect(body.referrer).toHaveLength(512);
    } finally {
      delete (document as unknown as Record<string, unknown>).referrer;
      void real;
    }
  });

  it('upper-cases a typed code and tolerates surrounding spaces', async () => {
    at('/?ref=%20aya012%20');
    render(<RefCapture />);
    expect(api).toHaveBeenCalledWith('/api/affiliate/click', { method: 'POST', body: { code: 'AYA012', landingPath: '/', referrer: '' } });
  });

  it.each(['', 'AYA', 'AY001', 'AYA01', 'AYA001x', '<script>', 'AYA001;DROP', 'ÀYA001', 'A'.repeat(500)])('never posts %j, but still cleans the URL', (bad) => {
    at(`/?ref=${encodeURIComponent(bad)}`);
    render(<RefCapture />);
    expect(api).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('does nothing without a ref parameter and leaves the URL alone', () => {
    at('/?utm_source=ig');
    render(<RefCapture />);
    expect(api).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?utm_source=ig');
  });

  it('removes ref even when the request fails, silently', async () => {
    api.mockResolvedValue({ ok: false, status: 0, code: 'network' });
    at('/?ref=AYA001');
    render(<RefCapture />);
    await vi.waitFor(() => expect(window.location.search).toBe(''));
  });

  it('reports a code once even under React strict mode (effects run twice)', () => {
    at('/?ref=AYA777');
    render(
      <StrictMode>
        <RefCapture />
      </StrictMode>,
    );
    expect(api).toHaveBeenCalledTimes(1);
  });
});

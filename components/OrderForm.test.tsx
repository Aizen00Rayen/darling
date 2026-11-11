// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

import { defaultProduct } from '@/data/products';
import { OrderForm } from './OrderForm';

const shade = defaultProduct.shades[1]!.code;
const form = () => document.querySelector('form#commande') as HTMLFormElement;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  push.mockReset();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, order: { number: 'DL-26-000042' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  window.fetch = fetchMock as unknown as typeof window.fetch;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Nom et prénom/), 'Amel B');
  await user.type(screen.getByLabelText(/Téléphone/), '0612345678');
  await user.selectOptions(screen.getByLabelText(/Wilaya/), '16');
  await user.type(screen.getByLabelText(/Commune/), 'Hydra');
  await user.click(screen.getByRole('button', { name: /CONFIRMER MA COMMANDE/ }));
}

describe('OrderForm markup', () => {
  it('is a POST form, so a native submit before hydration never puts the customer’s data in the URL', () => {
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    expect(form().getAttribute('method')?.toLowerCase()).toBe('post');
  });

  it('renders the submit button disabled on the server and during hydration', () => {
    const html = renderToString(<OrderForm product={defaultProduct} shadeCode={shade} />);
    expect(html).toMatch(/<form[^>]*method="post"/i);
    expect(html).toMatch(/<button[^>]*class="submit"[^>]*disabled/);
  });

  it('is enabled once it runs in the browser', () => {
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    expect((screen.getByRole('button', { name: /CONFIRMER MA COMMANDE/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('has a hidden honeypot field that people and assistive technology skip', () => {
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    const input = document.querySelector('input[name="website"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute('aria-hidden')).toBe('true');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.value).toBe('');
    expect(input.closest('.hp-field')).not.toBeNull();
  });
});

describe('OrderForm submit', () => {
  it('posts with the CSRF header and a fresh Idempotency-Key, then goes to /merci?n=<number>', async () => {
    const user = userEvent.setup();
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    await fillAndSubmit(user);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/merci?n=DL-26-000042'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orders');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('fetch');
    expect(headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ productSlug: defaultProduct.slug, shadeCode: shade, fullName: 'Amel B', phone: '0612345678', wilayaCode: 16, commune: 'Hydra', mode: 'desk' });
    expect('website' in body).toBe(false);
  });

  it('goes to plain /merci when the response carries no valid number', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const user = userEvent.setup();
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    await fillAndSubmit(user);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/merci'));
  });

  it('sends the honeypot only when something was typed into it', async () => {
    const user = userEvent.setup();
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    await user.type(document.querySelector('input[name="website"]') as HTMLInputElement, 'http://spam.example');
    await fillAndSubmit(user);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).website).toBe('http://spam.example');
  });

  it('shows a clear message on a 429 and keeps the form usable', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'too_many_attempts' }), { status: 429 }));
    const user = userEvent.setup();
    render(<OrderForm product={defaultProduct} shadeCode={shade} />);
    await fillAndSubmit(user);
    await waitFor(() => expect(document.getElementById('status')?.textContent).toMatch(/trop de commandes/i));
    expect(push).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /CONFIRMER MA COMMANDE/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

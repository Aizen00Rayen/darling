import { describe, expect, it } from 'vitest';
import { POST } from './route';

const valid = {
  productSlug: 'wet-kiss',
  shadeCode: '*02',
  quantity: 2,
  fullName: 'Amel B',
  phone: '0612345678',
  wilayaCode: 16,
  commune: 'Hydra',
  mode: 'desk',
};

const post = (body: unknown, raw = false) =>
  POST(
    new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );

describe('POST /api/orders', () => {
  it('returns the server-computed price, fee and total', async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      order: { ...valid, unitPrice: 3000, deliveryFee: 300, total: 6300 },
    });
  });

  it('ignores prices sent by the client', async () => {
    const res = await post({ ...valid, total: 1, unitPrice: 1, deliveryFee: 0 });
    expect((await res.json()).order).toMatchObject({ unitPrice: 3000, deliveryFee: 300, total: 6300 });
  });

  it('charges home delivery when chosen', async () => {
    const res = await post({ ...valid, quantity: 1, wilayaCode: 37, mode: 'home', address: 'Cité 5 juillet' });
    expect((await res.json()).order).toMatchObject({ deliveryFee: 1650, total: 4650 });
  });

  it('rejects an invalid field with 400 and a field error', async () => {
    const res = await post({ ...valid, phone: '123' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.phone).toBeTruthy();
  });

  it('rejects a body that is not JSON', async () => {
    const res = await post('not json', true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, errors: {} });
  });

  it('rejects JSON that is not an object', async () => {
    const res = await post('[]', true);
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });
});

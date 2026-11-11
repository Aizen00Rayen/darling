import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_NUMBER_PATTERN } from '@/shared';
import type { Permission } from '@/shared';
import { createTestApp, login, seedUser, totpCodeAt, type TestApp } from '../test/app';
import { orderInput } from '../test/orders';

let app: TestApp;
beforeEach(() => {
  app = createTestApp();
});
afterEach(() => {
  vi.restoreAllMocks();
  app.close();
});

const count = (table: string) => app.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
const place = (body: unknown, init: { ip?: string; headers?: Record<string, string | null> } = {}) => app.call('/api/orders', { body, ...init });

async function staff(permissions: Permission[], opts: { owner?: boolean } = {}) {
  const u = await seedUser(app, { role: 'super_manager', permissions, totp: true, ...(opts.owner ? { isOwner: true } : {}) });
  const cookie = await login(app, u.email, u.password, { totpCode: totpCodeAt(u.totpSecret!, app.clock.now()) });
  return { id: u.id, cookie };
}

describe('POST /api/orders (storefront intake)', () => {
  it('stores the order as a website order and returns the contract plus the number', async () => {
    const res = await place(orderInput());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, order: { ...orderInput(), unitPrice: 3000, deliveryFee: 300, total: 6300, number: 'DL-23-000001' } });
    expect(body.order.number).toMatch(ORDER_NUMBER_PATTERN);
    expect(app.db.get('SELECT source, status, created_by, customer_name, total FROM orders')).toEqual({
      source: 'website',
      status: 'new',
      created_by: null,
      customer_name: 'Amel B',
      total: 6300,
    });
    expect(count('order_status_history')).toBe(1);
  });

  it('normalises the phone and reprices on the server, ignoring everything the client claims', async () => {
    const res = await place({ ...orderInput({ phone: '0612345678' }), phone: '+213 612 34 56 78', unitPrice: 1, deliveryFee: 0, total: 1, status: 'delivered', source: 'affiliate', createdBy: 'x' });
    const body = await res.json();
    expect(body.order).toMatchObject({ phone: '0612345678', unitPrice: 3000, deliveryFee: 300, total: 6300 });
    expect(app.db.get('SELECT status, source, phone, unit_price, total FROM orders')).toEqual({ status: 'new', source: 'website', phone: '0612345678', unit_price: 3000, total: 6300 });
  });

  it('rejects an invalid order with 400 { ok: false, errors } and stores nothing', async () => {
    const res = await place({ ...orderInput(), phone: '123', wilayaCode: 37, mode: 'desk' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.phone).toBeTruthy();
    expect(count('orders')).toBe(0);
  });

  it('a malformed body is 400 { ok: false, errors: {} } and an oversized one 413', async () => {
    const bad = await app.call('/api/orders', { rawBody: 'not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, errors: {} });
    const big = await app.call('/api/orders', { rawBody: JSON.stringify({ commune: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    expect(count('orders')).toBe(0);
  });

  it('still needs the CSRF headers', async () => {
    expect((await place(orderInput(), { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await place(orderInput(), { headers: { 'X-Requested-With': null } })).status).toBe(403);
    expect(count('orders')).toBe(0);
  });

  it('is never cacheable', async () => {
    expect((await place(orderInput())).headers.get('cache-control')).toBe('no-store');
  });

  describe('honeypot', () => {
    it.each([['a url'], ['x'], [' x ']])('a filled `website` field (%s) gets a fake success and stores nothing', async (value) => {
      const res = await place({ ...orderInput(), website: value });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.order.number).toMatch(ORDER_NUMBER_PATTERN);
      expect(body.order).toMatchObject({ total: 6300 }); // same shape as a real success
      expect(count('orders')).toBe(0);
      expect(count('order_status_history')).toBe(0);
      expect(count('audit_log')).toBe(0);
    });

    it('also for a non-string value, and even when the rest of the order is invalid', async () => {
      for (const website of [1, true, ['a'], { a: 1 }]) {
        const res = await place({ ...orderInput(), website });
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
      }
      const res = await place({ website: 'bot' });
      expect(res.status).toBe(200);
      expect((await res.json()).order.number).toMatch(ORDER_NUMBER_PATTERN);
      expect(count('orders')).toBe(0);
    });

    it('an empty or whitespace-only honeypot is a normal order', async () => {
      expect((await place({ ...orderInput(), website: '' })).status).toBe(200);
      expect((await place({ ...orderInput({ phone: '0712345678' }), website: '   ' })).status).toBe(200);
      expect(count('orders')).toBe(2);
    });

    it('does not use up the rate limits (a bot does not lock a customer out)', async () => {
      for (let i = 0; i < 5; i += 1) await place({ ...orderInput(), website: 'bot' }, { ip: '10.1.1.1' });
      for (let i = 0; i < 3; i += 1) expect((await place(orderInput(), { ip: '10.1.1.1' })).status).toBe(200);
    });
  });

  describe('Idempotency-Key', () => {
    const KEY = '3f2b1c9e-8a4d-4e6f-9b1a-0c5d7e8f9a10';

    it('a double submit with the same key makes one order and answers the same number twice', async () => {
      const a = await place(orderInput(), { headers: { 'Idempotency-Key': KEY } });
      const b = await place(orderInput(), { headers: { 'Idempotency-Key': KEY } });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((await b.json()).order).toEqual((await a.json()).order);
      expect(count('orders')).toBe(1);
      expect(count('order_status_history')).toBe(1);
    });

    it('concurrent submissions with the same key make one order', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => place(orderInput(), { headers: { 'Idempotency-Key': KEY } })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set((await Promise.all(results.map((r) => r.json()))).map((b) => b.order.number)).size).toBe(1);
      expect(count('orders')).toBe(1);
    });

    it('a retry does not count against the phone limit', async () => {
      for (let i = 0; i < 6; i += 1) expect((await place(orderInput(), { headers: { 'Idempotency-Key': KEY } })).status).toBe(200);
      expect((await place(orderInput(), { headers: { 'Idempotency-Key': 'another-key-0001' } })).status).toBe(200);
      expect((await place(orderInput(), { headers: { 'Idempotency-Key': 'another-key-0002' } })).status).toBe(200);
      expect(count('orders')).toBe(3);
    });

    it('a different key is a different order', async () => {
      await place(orderInput(), { headers: { 'Idempotency-Key': KEY } });
      await place(orderInput(), { headers: { 'Idempotency-Key': 'another-key-0001' } });
      expect(count('orders')).toBe(2);
    });

    it('the same key from another customer never returns the first customer’s order', async () => {
      const first = await place(orderInput({ fullName: 'Amel B', phone: '0612345678' }), { headers: { 'Idempotency-Key': KEY } });
      const other = await place(orderInput({ fullName: 'Sara K', phone: '0712345678' }), { headers: { 'Idempotency-Key': KEY } });
      expect(first.status).toBe(200);
      expect(other.status).toBe(409);
      const text = await other.text();
      expect(text).not.toContain('Amel');
      expect(text).not.toContain('0612345678');
      expect(count('orders')).toBe(1);
    });

    it.each([['short'], ['has space in it'], ['x'.repeat(65)], ['semi;colon-0123'], ["quote'quote-0123"], ['élément-0123']])('refuses a malformed key (%s)', async (key) => {
      const res = await place(orderInput(), { headers: { 'Idempotency-Key': key } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, code: 'invalid_idempotency_key', errors: {} });
      expect(count('orders')).toBe(0);
    });

    it('accepts 64 characters and a plain UUID', async () => {
      expect((await place(orderInput(), { headers: { 'Idempotency-Key': 'k'.repeat(64) } })).status).toBe(200);
      expect((await place(orderInput({ phone: '0712345678' }), { headers: { 'Idempotency-Key': crypto.randomUUID() } })).status).toBe(200);
    });

    it('is optional', async () => {
      expect((await place(orderInput())).status).toBe(200);
      expect((await place(orderInput())).status).toBe(200);
      expect(count('orders')).toBe(2);
    });
  });

  describe('rate limits', () => {
    it('30 orders an hour per client address, then 429 too_many_attempts with Retry-After', async () => {
      for (let i = 0; i < 30; i += 1) {
        // a different phone each time so only the address budget is in play
        const res = await place(orderInput({ phone: `06${String(10_000_000 + i)}` }), { ip: '10.2.2.2' });
        expect(res.status, `order ${i + 1}`).toBe(200);
      }
      const res = await place(orderInput({ phone: '0699999999' }), { ip: '10.2.2.2' });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ code: 'too_many_attempts' });
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(count('orders')).toBe(30);
      expect((await place(orderInput({ phone: '0699999998' }), { ip: '10.3.3.3' })).status).toBe(200); // another address is unaffected
    });

    it('the budget comes back after an hour', async () => {
      for (let i = 0; i < 31; i += 1) await place(orderInput({ phone: `06${String(10_000_000 + i)}` }), { ip: '10.2.2.2' });
      app.clock.advance(3_600_001);
      expect((await place(orderInput({ phone: '0699999999' }), { ip: '10.2.2.2' })).status).toBe(200);
    });

    it('the shared "unknown" bucket gets four times the budget', async () => {
      const unknown = { headers: { 'X-Forwarded-For': null as string | null } };
      let ok = 0;
      for (let i = 0; i < 125; i += 1) {
        const res = await place(orderInput({ phone: `06${String(20_000_000 + i)}` }), unknown);
        if (res.status === 200) ok += 1;
        else expect(res.status).toBe(429);
      }
      expect(ok).toBe(120);
    });

    it('at most 3 orders an hour per phone number, from any address, then 429', async () => {
      for (let i = 0; i < 3; i += 1) expect((await place(orderInput())).status).toBe(200);
      const res = await place(orderInput());
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ code: 'too_many_attempts' });
      expect(count('orders')).toBe(3);
      // the phone is judged after normalisation: the same number typed another way is the same budget
      expect((await place({ ...orderInput(), phone: '+213 6 12 34 56 78' })).status).toBe(429);
      // another phone is fine, and so is the same one an hour later
      expect((await place(orderInput({ phone: '0712345678' }))).status).toBe(200);
      app.clock.advance(3_600_001);
      expect((await place(orderInput())).status).toBe(200);
    });

    it('invalid orders do not use up either budget', async () => {
      for (let i = 0; i < 40; i += 1) await place({ ...orderInput(), phone: '1' }, { ip: '10.4.4.4' });
      for (let i = 0; i < 3; i += 1) expect((await place(orderInput(), { ip: '10.4.4.4' })).status).toBe(200);
    });
  });

  it('never logs the customer name or phone number', async () => {
    const written: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(' ')));
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => (written.push(String(chunk)), true)) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => (written.push(String(chunk)), true)) as never);
    await place(orderInput({ fullName: 'Zzyzx Qwerty', phone: '0698765432' }));
    await place({ ...orderInput({ fullName: 'Zzyzx Qwerty', phone: '0698765432' }), website: 'bot' });
    await place({ ...orderInput({ fullName: 'Zzyzx Qwerty' }), phone: '12' });
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const failed = await place(orderInput({ fullName: 'Zzyzx Qwerty', phone: '0698765433' }));
    expect(failed.status).toBe(500);
    expect(written.join('\n')).not.toMatch(/Zzyzx|Qwerty|0698765432|0698765433/);
  });
});

describe('GET /api/orders (staff list)', () => {
  it('lists, filters and paginates for orders.read', async () => {
    const me = await staff(['orders.read']);
    for (let i = 0; i < 3; i += 1) {
      app.clock.advance(1000);
      await place(orderInput({ fullName: `Client ${i}`, phone: `06${String(30_000_000 + i)}` }));
    }
    const all = await app.call('/api/orders', { cookie: me.cookie });
    expect(all.status).toBe(200);
    const body = await all.json();
    expect(body.total).toBe(3);
    expect(body.items.map((i: { customerName: string }) => i.customerName)).toEqual(['Client 2', 'Client 1', 'Client 0']);
    expect(Object.keys(body.items[0]).sort()).toEqual(['createdAt', 'customerName', 'id', 'number', 'phone', 'source', 'status', 'total', 'wilayaName']);
    const q = await (await app.call('/api/orders?q=client%201&status=new&source=website&from=2023-11-14&to=2023-11-15&page=1', { cookie: me.cookie })).json();
    expect(q.items).toHaveLength(1);
    expect((await (await app.call('/api/orders?status=shipped', { cookie: me.cookie })).json()).total).toBe(0);
  });

  it.each([
    ['status=paid', 'status'],
    ['source=tiktok', 'source'],
    ['from=2026-02-30', 'from'],
    ['from=2026-05-02&to=2026-05-01', 'to'],
    ['page=0', 'page'],
    ['page=1&page=2', 'page'],
    [`q=${'x'.repeat(101)}`, 'q'],
  ])('rejects ?%s with a validation error on %s', async (qs, field) => {
    const me = await staff(['orders.read']);
    const res = await app.call(`/api/orders?${qs}`, { cookie: me.cookie });
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).errors)).toContain(field);
  });
});

describe('GET /api/orders/:id and PATCH (notes)', () => {
  it('returns the order with its history, 404 for unknown or malformed ids', async () => {
    const me = await staff(['orders.read']);
    const { order } = await (await place(orderInput())).json();
    void order;
    const id = app.db.get<{ id: string }>('SELECT id FROM orders')!.id;
    const res = await app.call(`/api/orders/${id}`, { cookie: me.cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id, number: 'DL-23-000001', status: 'new', customerName: 'Amel B', phone: '0612345678', internalNotes: null, address: null });
    expect(body.history).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'new', actor: null })]);
    for (const bad of ['018f0000-0000-7000-8000-000000000000', 'nope', '1%27%20OR%201=1']) {
      expect((await app.call(`/api/orders/${bad}`, { cookie: me.cookie })).status).toBe(404);
    }
  });

  it('PATCH saves the notes for orders.write and validates the body', async () => {
    const me = await staff(['orders.read', 'orders.write']);
    await place(orderInput());
    const id = app.db.get<{ id: string }>('SELECT id FROM orders')!.id;
    const ok = await app.call(`/api/orders/${id}`, { method: 'PATCH', body: { internalNotes: 'appeler après 18h' }, cookie: me.cookie });
    expect(ok.status).toBe(200);
    expect((await ok.json()).internalNotes).toBe('appeler après 18h');
    expect((await app.call(`/api/orders/${id}`, { method: 'PATCH', body: {}, cookie: me.cookie })).status).toBe(400);
    expect((await app.call(`/api/orders/${id}`, { method: 'PATCH', body: { internalNotes: 5 }, cookie: me.cookie })).status).toBe(400);
    const tooLong = await app.call(`/api/orders/${id}`, { method: 'PATCH', body: { internalNotes: 'x'.repeat(2001) }, cookie: me.cookie });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).errors.internalNotes).toBeTruthy();
    const cleared = await app.call(`/api/orders/${id}`, { method: 'PATCH', body: { internalNotes: null }, cookie: me.cookie });
    expect((await cleared.json()).internalNotes).toBeNull();
    expect(app.db.all("SELECT action FROM audit_log WHERE action = 'order.notes_updated'")).toHaveLength(2);
  });
});

describe('POST /api/orders/:id/status', () => {
  async function newOrderId() {
    await place(orderInput());
    return app.db.get<{ id: string }>('SELECT id FROM orders ORDER BY seq DESC')!.id;
  }

  it('walks the machine and returns the updated order with its history', async () => {
    const me = await staff(['orders.write']);
    const id = await newOrderId();
    let last: { status: string; history: unknown[] } | undefined;
    for (const to of ['confirmed', 'shipped', 'delivered']) {
      app.clock.advance(1000);
      const res = await app.call(`/api/orders/${id}/status`, { body: { to }, cookie: me.cookie });
      expect(res.status).toBe(200);
      last = await res.json();
      expect(last?.status).toBe(to);
    }
    expect(last?.history).toHaveLength(4);
    expect(app.db.all("SELECT action FROM audit_log WHERE action = 'order.status_changed'")).toHaveLength(3);
  });

  it('an illegal change and the same status are 409 invalid_transition, changing nothing', async () => {
    const me = await staff(['orders.write']);
    const id = await newOrderId();
    for (const to of ['delivered', 'returned', 'refused', 'new']) {
      const res = await app.call(`/api/orders/${id}/status`, { body: { to }, cookie: me.cookie });
      expect(res.status, to).toBe(409);
      expect(await res.json()).toEqual({ code: 'invalid_transition' });
    }
    await app.call(`/api/orders/${id}/status`, { body: { to: 'confirmed' }, cookie: me.cookie });
    expect((await app.call(`/api/orders/${id}/status`, { body: { to: 'confirmed' }, cookie: me.cookie })).status).toBe(409);
    expect(app.db.get('SELECT status FROM orders')).toEqual({ status: 'confirmed' });
    expect(count('order_status_history')).toBe(2);
  });

  it('keeps the optional note, 400 for a bad status, a bad body or a too long note, 404 for an unknown order', async () => {
    const me = await staff(['orders.write']);
    const id = await newOrderId();
    const ok = await app.call(`/api/orders/${id}/status`, { body: { to: 'cancelled', note: 'client injoignable' }, cookie: me.cookie });
    expect((await ok.json()).history.at(-1)).toMatchObject({ toStatus: 'cancelled', note: 'client injoignable' });
    const id2 = await newOrderId();
    expect((await app.call(`/api/orders/${id2}/status`, { body: { to: 'paid' }, cookie: me.cookie })).status).toBe(400);
    expect((await app.call(`/api/orders/${id2}/status`, { body: {}, cookie: me.cookie })).status).toBe(400);
    expect((await app.call(`/api/orders/${id2}/status`, { body: { to: 'confirmed', note: 'x'.repeat(501) }, cookie: me.cookie })).status).toBe(400);
    expect((await app.call('/api/orders/018f0000-0000-7000-8000-000000000000/status', { body: { to: 'confirmed' }, cookie: me.cookie })).status).toBe(404);
    expect(app.db.get('SELECT status FROM orders WHERE id = ?', id2)).toEqual({ status: 'new' });
  });
});

describe('a staff member with orders.read only cannot write', () => {
  it('gets 403 on status, notes and manual entry, and nothing changes', async () => {
    const reader = await staff(['orders.read']);
    await place(orderInput());
    const id = app.db.get<{ id: string }>('SELECT id FROM orders')!.id;
    const before = app.db.all('SELECT * FROM orders');
    const status = await app.call(`/api/orders/${id}/status`, { body: { to: 'confirmed' }, cookie: reader.cookie });
    const notes = await app.call(`/api/orders/${id}`, { method: 'PATCH', body: { internalNotes: 'x' }, cookie: reader.cookie });
    const manual = await app.call('/api/orders/manual', { body: { ...orderInput(), source: 'whatsapp' }, cookie: reader.cookie });
    for (const res of [status, notes, manual]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'forbidden' });
    }
    expect(app.db.all('SELECT * FROM orders')).toEqual(before);
    expect(count('order_status_history')).toBe(1);
    expect(count('audit_log')).toBe(0);
    // ... while reading works
    expect((await app.call(`/api/orders/${id}`, { cookie: reader.cookie })).status).toBe(200);
    expect((await app.call('/api/orders', { cookie: reader.cookie })).status).toBe(200);
  });

  it('a writer without orders.read can write but not read', async () => {
    const writer = await staff(['orders.write']);
    expect((await app.call('/api/orders', { cookie: writer.cookie })).status).toBe(403);
    expect((await app.call('/api/orders/manual', { body: { ...orderInput(), source: 'whatsapp' }, cookie: writer.cookie })).status).toBe(201);
  });
});

describe('POST /api/orders/manual', () => {
  it('creates an order for the actor with the chosen source, priced on the server', async () => {
    const me = await staff(['orders.write']);
    const res = await app.call('/api/orders/manual', { body: { ...orderInput({ quantity: 1, wilayaCode: 37, mode: 'home', address: 'Cité 5 juillet' }), source: 'whatsapp', total: 1 }, cookie: me.cookie });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ number: 'DL-23-000001', source: 'whatsapp', status: 'new', total: 4650, createdBy: { id: me.id }, deliveryMode: 'home', address: 'Cité 5 juillet' });
    expect(body.history).toHaveLength(1);
    expect(app.db.get("SELECT actor_user_id, action, entity_id FROM audit_log WHERE action = 'order.created_manual'")).toEqual({ actor_user_id: me.id, action: 'order.created_manual', entity_id: body.id });
  });

  it.each(['instagram', 'whatsapp', 'facebook', 'direct', 'other'])('accepts source %s', async (source) => {
    const me = await staff(['orders.write']);
    expect((await app.call('/api/orders/manual', { body: { ...orderInput({ phone: `07${String(40_000_000 + source.length)}` }), source }, cookie: me.cookie })).status).toBe(201);
  });

  it.each([[undefined], ['website'], ['affiliate'], ['tiktok'], [''], [5], [null]])('refuses source %s with a field error', async (source) => {
    const me = await staff(['orders.write']);
    const res = await app.call('/api/orders/manual', { body: { ...orderInput(), ...(source === undefined ? {} : { source }) }, cookie: me.cookie });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('validation');
    expect(body.errors.source).toBeTruthy();
    expect(count('orders')).toBe(0);
  });

  it('validates like the storefront and reports every field error at once', async () => {
    const me = await staff(['orders.write']);
    const res = await app.call('/api/orders/manual', { body: { source: 'whatsapp', fullName: 'A', phone: '12', wilayaCode: 37, mode: 'desk', commune: '', productSlug: 'wet-kiss', shadeCode: '*02', quantity: 1 }, cookie: me.cookie });
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).errors).sort()).toEqual(['commune', 'fullName', 'mode', 'phone']);
    expect(count('orders')).toBe(0);
    expect((await app.call('/api/orders/manual', { rawBody: '[]', cookie: me.cookie })).status).toBe(400);
    expect((await app.call('/api/orders/manual', { rawBody: 'nope', cookie: me.cookie })).status).toBe(400);
  });

  it('is not rate limited like the storefront (staff may enter many orders for one number)', async () => {
    const me = await staff(['orders.write']);
    for (let i = 0; i < 5; i += 1) expect((await app.call('/api/orders/manual', { body: { ...orderInput(), source: 'direct' }, cookie: me.cookie })).status).toBe(201);
  });
});

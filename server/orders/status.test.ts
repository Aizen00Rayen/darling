import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTERNAL_NOTES_MAX, ORDER_STATUSES, canTransition, type OrderStatus } from '@/shared';
import { HttpFailure } from '../admin/errors';
import { createTestApp, seedUser, type TestApp } from '../test/app';
import { forceStatus, orderInput, seedStaff } from '../test/orders';
import { createOrder } from './create';
import { InvalidTransitionError } from './errors';
import { getOrder } from './read';
import { changeStatus, updateNotes } from './status';
import type { OrderActor } from './types';

let app: TestApp;
let actor: OrderActor;
beforeEach(async () => {
  app = createTestApp();
  actor = await seedStaff(app);
});
afterEach(() => app.close());

const newOrder = () => createOrder(app, orderInput(), { source: 'website' }).order;
const audits = () => app.db.all<{ actor_user_id: string; action: string; entity_type: string; entity_id: string; before: string; after: string; reason: string | null; ip: string; request_id: string }>('SELECT * FROM audit_log ORDER BY id');

describe('changeStatus: every ordered pair of statuses', () => {
  const pairs = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s -> %s', (from, to) => {
    const order = newOrder();
    forceStatus(app, order.id, from);
    const before = app.db.get<{ updated_at: number }>('SELECT updated_at FROM orders WHERE id = ?', order.id)!.updated_at;
    app.clock.advance(1000);

    if (canTransition(from, to)) {
      const result = changeStatus(app, actor, order.id, to);
      expect(result.status).toBe(to);
      expect(result.updatedAt).toBe(new Date(app.clock.now()).toISOString());
    } else {
      expect(() => changeStatus(app, actor, order.id, to)).toThrow(InvalidTransitionError);
      expect(() => changeStatus(app, actor, order.id, to)).toThrow(expect.objectContaining({ status: 409, code: 'invalid_transition', from, to }));
      // an illegal change leaves no trace
      const row = app.db.get<{ status: string; updated_at: number }>('SELECT status, updated_at FROM orders WHERE id = ?', order.id)!;
      expect(row).toEqual({ status: from, updated_at: before });
      expect(app.db.get('SELECT count(*) AS n FROM order_status_history')).toEqual({ n: 1 }); // only the creation row
      expect(audits()).toHaveLength(0);
    }
  });
});

describe('changeStatus: effects of a legal change', () => {
  it('walks new -> confirmed -> shipped -> delivered setting each timestamp, history row and audit row', () => {
    const order = newOrder();
    const t0 = app.clock.now();
    const steps: [OrderStatus, string][] = [
      ['confirmed', 'confirmed_at'],
      ['shipped', 'shipped_at'],
      ['delivered', 'delivered_at'],
    ];
    let previous: OrderStatus = 'new';
    steps.forEach(([to, column], i) => {
      app.clock.advance(60_000);
      const result = changeStatus(app, actor, order.id, to, i === 0 ? '  appelé, OK  ' : undefined);
      const row = app.db.get<Record<string, number | null>>('SELECT * FROM orders WHERE id = ?', order.id)!;
      expect(row[column]).toBe(app.clock.now());
      expect(row.updated_at).toBe(app.clock.now());
      expect(row.closed_at).toBeNull();
      expect(result.status).toBe(to);
      expect(result.history.at(-1)).toMatchObject({ fromStatus: previous, toStatus: to, actor: { id: actor.userId } });
      previous = to;
    });
    expect(getOrder(app.db, order.id).history.map((h) => [h.fromStatus, h.toStatus, h.note])).toEqual([
      [null, 'new', null],
      ['new', 'confirmed', 'appelé, OK'],
      ['confirmed', 'shipped', null],
      ['shipped', 'delivered', null],
    ]);
    expect(app.db.get<{ created_at: number }>('SELECT created_at FROM orders')!.created_at).toBe(t0);
    expect(audits().map((a) => [a.action, JSON.parse(a.before).status, JSON.parse(a.after).status])).toEqual([
      ['order.status_changed', 'new', 'confirmed'],
      ['order.status_changed', 'confirmed', 'shipped'],
      ['order.status_changed', 'shipped', 'delivered'],
    ]);
    const first = audits()[0]!;
    expect(first).toMatchObject({ actor_user_id: actor.userId, entity_type: 'order', entity_id: order.id, reason: 'appelé, OK', ip: '10.9.9.9', request_id: 'req-test' });
  });

  it.each([
    ['new', 'cancelled'],
    ['confirmed', 'cancelled'],
    ['shipped', 'cancelled'],
    ['shipped', 'refused'],
    ['delivered', 'returned'],
  ] as const)('%s -> %s sets closed_at and nothing else', (from, to) => {
    const order = newOrder();
    forceStatus(app, order.id, from);
    app.clock.advance(5000);
    changeStatus(app, actor, order.id, to);
    expect(app.db.get('SELECT status, closed_at, confirmed_at, shipped_at, delivered_at FROM orders')).toEqual({
      status: to,
      closed_at: app.clock.now(),
      confirmed_at: null,
      shipped_at: null,
      delivered_at: null,
    });
  });

  it('keeps earlier timestamps when a later one is set', () => {
    const order = newOrder();
    app.clock.advance(1000);
    changeStatus(app, actor, order.id, 'confirmed');
    const confirmedAt = app.clock.now();
    app.clock.advance(1000);
    changeStatus(app, actor, order.id, 'shipped');
    app.clock.advance(1000);
    changeStatus(app, actor, order.id, 'cancelled');
    expect(app.db.get('SELECT confirmed_at, shipped_at, closed_at FROM orders')).toEqual({
      confirmed_at: confirmedAt,
      shipped_at: confirmedAt + 1000,
      closed_at: confirmedAt + 2000,
    });
  });

  it('refuses the same status with 409 invalid_transition', () => {
    const order = newOrder();
    expect(() => changeStatus(app, actor, order.id, 'new')).toThrow(expect.objectContaining({ status: 409, code: 'invalid_transition' }));
    changeStatus(app, actor, order.id, 'confirmed');
    expect(() => changeStatus(app, actor, order.id, 'confirmed')).toThrow(expect.objectContaining({ status: 409, code: 'invalid_transition' }));
  });

  it('stores an empty note as no note, trims and bounds the note', () => {
    const order = newOrder();
    changeStatus(app, actor, order.id, 'confirmed', '   ');
    expect(app.db.get('SELECT note FROM order_status_history WHERE to_status = ?', 'confirmed')).toEqual({ note: null });
    expect(() => changeStatus(app, actor, order.id, 'shipped', 'x'.repeat(501))).toThrow(expect.objectContaining({ status: 400, code: 'validation' }));
    expect(getOrder(app.db, order.id).status).toBe('confirmed');
  });

  it('answers 404 for an unknown or malformed id', () => {
    for (const id of ['018f0000-0000-7000-8000-000000000000', 'nope', "x' OR 1=1 --"]) {
      expect(() => changeStatus(app, actor, id, 'confirmed')).toThrow(expect.objectContaining({ status: 404 }));
    }
  });

  it('rolls the status back when the audit write fails (one transaction)', () => {
    const order = newOrder();
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => changeStatus(app, actor, order.id, 'confirmed')).toThrow(/boom/);
    expect(app.db.get('SELECT status, confirmed_at FROM orders')).toEqual({ status: 'new', confirmed_at: null });
    expect(app.db.get('SELECT count(*) AS n FROM order_status_history')).toEqual({ n: 1 });
  });

  it('rolls everything back when the history insert fails', () => {
    const order = newOrder();
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON order_status_history BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => changeStatus(app, actor, order.id, 'confirmed')).toThrow(/boom/);
    expect(app.db.get('SELECT status FROM orders')).toEqual({ status: 'new' });
    expect(audits()).toHaveLength(0);
  });
});

describe('changeStatus: no stale reads', () => {
  it('judges the transition on the status as it is inside the transaction, not as the caller saw it', () => {
    const order = newOrder();
    // The caller looked at the order while it was 'new' ...
    expect(getOrder(app.db, order.id).status).toBe('new');
    // ... but somebody else cancelled it before the change ran.
    changeStatus(app, actor, order.id, 'cancelled');
    expect(() => changeStatus(app, actor, order.id, 'confirmed')).toThrow(InvalidTransitionError);
    expect(getOrder(app.db, order.id).status).toBe('cancelled');
  });

  it('of two racing changes from the same status exactly one wins (file database, three connections)', async () => {
    const file = createTestApp({ file: true, connections: 3 });
    try {
      const staff = await seedStaff(file);
      const { order } = createOrder(file, orderInput(), { source: 'website' });
      const outcomes = await Promise.allSettled(
        (['confirmed', 'cancelled', 'confirmed', 'cancelled'] as const).map(async (to) => {
          await Promise.resolve();
          return changeStatus(file, staff, order.id, to);
        }),
      );
      const ok = outcomes.filter((o) => o.status === 'fulfilled');
      // confirmed -> (cancelled) is legal too, so possible winners: confirmed then cancelled, or cancelled alone
      const final = getOrder(file.db, order.id);
      expect(['confirmed', 'cancelled']).toContain(final.status);
      expect(final.history).toHaveLength(1 + ok.length);
      for (const o of outcomes) if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(InvalidTransitionError);
      // every history row chains onto the previous one
      final.history.slice(1).forEach((h, i) => expect(h.fromStatus).toBe(final.history[i]!.toStatus));
    } finally {
      file.close();
    }
  });

  it('re-authorises the actor inside the transaction (suspended or demoted between the check and the change)', async () => {
    const order = newOrder();
    app.db.run("UPDATE users SET status = 'suspended' WHERE id = ?", actor.userId);
    expect(() => changeStatus(app, actor, order.id, 'confirmed')).toThrow(expect.objectContaining({ status: 403 }));
    app.db.run("UPDATE users SET status = 'active' WHERE id = ?", actor.userId);
    app.db.run("DELETE FROM user_permissions WHERE user_id = ? AND permission = 'orders.write'", actor.userId);
    expect(() => changeStatus(app, actor, order.id, 'confirmed')).toThrow(expect.objectContaining({ status: 403 }));
    expect(getOrder(app.db, order.id).status).toBe('new');
    expect(audits()).toHaveLength(0);
  });

  it('refuses (403) a read-only staff member, an affiliate and an unknown actor', async () => {
    const order = newOrder();
    const readOnly = await seedStaff(app, ['orders.read']);
    const affiliate = await seedUser(app, { role: 'affiliate' });
    for (const userId of [readOnly.userId, affiliate.id, '018f0000-0000-7000-8000-000000000000']) {
      expect(() => changeStatus(app, { ...actor, userId }, order.id, 'confirmed')).toThrow(expect.objectContaining({ status: 403 }));
    }
    expect(getOrder(app.db, order.id).status).toBe('new');
  });

  it('lets an owner change a status without explicit grants', async () => {
    const owner = await seedUser(app, { role: 'super_manager', isOwner: true });
    const order = newOrder();
    expect(changeStatus(app, { ...actor, userId: owner.id }, order.id, 'confirmed').status).toBe('confirmed');
  });
});

describe('updateNotes', () => {
  it('stores the notes, bumps updated_at and writes an audit row without the text', () => {
    const order = newOrder();
    app.clock.advance(2000);
    const updated = updateNotes(app, actor, order.id, '  Cliente préfère être appelée après 18h  ');
    expect(updated.internalNotes).toBe('Cliente préfère être appelée après 18h');
    expect(updated.updatedAt).toBe(new Date(app.clock.now()).toISOString());
    expect(updated.status).toBe('new');
    const [row] = audits();
    expect(row).toMatchObject({ actor_user_id: actor.userId, action: 'order.notes_updated', entity_type: 'order', entity_id: order.id });
    expect(`${row!.before}${row!.after}`).not.toContain('18h');
    expect(app.db.get('SELECT count(*) AS n FROM order_status_history')).toEqual({ n: 1 }); // not a status change
  });

  it('accepts exactly 2000 characters, refuses 2001 and clears with null or blank', () => {
    const order = newOrder();
    expect(updateNotes(app, actor, order.id, 'x'.repeat(INTERNAL_NOTES_MAX)).internalNotes).toHaveLength(2000);
    expect(() => updateNotes(app, actor, order.id, 'x'.repeat(2001))).toThrow(expect.objectContaining({ status: 400, code: 'validation' }));
    expect(updateNotes(app, actor, order.id, '   ').internalNotes).toBeNull();
    updateNotes(app, actor, order.id, 'abc');
    expect(updateNotes(app, actor, order.id, null).internalNotes).toBeNull();
  });

  it('works on an order in any status (including final ones)', () => {
    const order = newOrder();
    forceStatus(app, order.id, 'returned');
    expect(updateNotes(app, actor, order.id, 'retour reçu').internalNotes).toBe('retour reçu');
  });

  it('is 404 for unknown ids and 403 without orders.write (re-read in the transaction)', async () => {
    const order = newOrder();
    expect(() => updateNotes(app, actor, '018f0000-0000-7000-8000-000000000000', 'x')).toThrow(expect.objectContaining({ status: 404 }));
    const readOnly = await seedStaff(app, ['orders.read']);
    expect(() => updateNotes(app, readOnly, order.id, 'x')).toThrow(HttpFailure);
    expect(() => updateNotes(app, readOnly, order.id, 'x')).toThrow(expect.objectContaining({ status: 403 }));
    expect(getOrder(app.db, order.id).internalNotes).toBeNull();
  });
});

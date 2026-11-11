import { describe, expect, it } from 'vitest';
import { ORDER_NUMBER_PATTERN, ORDER_STATUSES, ORDER_TRANSITIONS, canTransition, nextStatuses, type OrderStatus } from './orders';

// The machine, written out independently of ORDER_TRANSITIONS so a change to the table fails here.
const LEGAL: Record<OrderStatus, OrderStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled', 'refused'],
  delivered: ['returned'],
  cancelled: [],
  refused: [],
  returned: [],
};

describe('order status machine', () => {
  const pairs = ORDER_STATUSES.flatMap((from) => ORDER_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(LEGAL[from].includes(to));
  });

  it('lists the next statuses of each status', () => {
    for (const from of ORDER_STATUSES) expect([...nextStatuses(from)]).toEqual(LEGAL[from]);
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('never allows staying on the same status', () => {
    for (const s of ORDER_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('ORDER_NUMBER_PATTERN', () => {
  it('accepts DL-YY-NNNNNN only', () => {
    expect(ORDER_NUMBER_PATTERN.test('DL-26-000123')).toBe(true);
    for (const bad of ['DL-26-123', 'dl-26-000123', 'DL-2026-000123', 'DL-26-000123\n', ' DL-26-000123', '<b>', 'DL-26-0001234']) {
      expect(ORDER_NUMBER_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

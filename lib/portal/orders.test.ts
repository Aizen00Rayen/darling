import { describe, expect, it } from 'vitest';
import { ORDER_SOURCES, ORDER_STATUSES, nextStatuses } from '@/shared';
import { apiMessage } from './messages';
import { auditActionLabel } from './labels';
import { deliveryModeLabel, formatPhone, orderActionFor, orderSourceLabel, orderSourceTone, orderStatusLabel, orderStatusTone, shadeLabel } from './orders';

describe('status and source labels', () => {
  it('has a French label and a tone for every status and source', () => {
    for (const s of ORDER_STATUSES) {
      expect(orderStatusLabel(s), s).toMatch(/\S/);
      expect(orderStatusTone(s), s).toMatch(/^(neutral|pink|success|warning|danger)$/);
    }
    for (const s of ORDER_SOURCES) {
      expect(orderSourceLabel(s), s).toMatch(/\S/);
      expect(orderSourceTone(s), s).toMatch(/^(neutral|pink|success|warning|danger)$/);
    }
  });

  it('uses the expected names', () => {
    expect(orderStatusLabel('new')).toBe('Nouvelle');
    expect(orderStatusLabel('confirmed')).toBe('Confirmée');
    expect(orderStatusLabel('shipped')).toBe('Expédiée');
    expect(orderStatusLabel('delivered')).toBe('Livrée');
    expect(orderStatusLabel('cancelled')).toBe('Annulée');
    expect(orderStatusLabel('refused')).toBe('Refusée');
    expect(orderStatusLabel('returned')).toBe('Retournée');
    expect(orderSourceLabel('website')).toBe('Site web');
    expect(orderSourceLabel('whatsapp')).toBe('WhatsApp');
  });

  it('colours new as a warning, delivered as success and the unhappy endings as danger', () => {
    expect(orderStatusTone('new')).toBe('warning');
    expect(orderStatusTone('delivered')).toBe('success');
    for (const s of ['cancelled', 'refused', 'returned'] as const) expect(orderStatusTone(s)).toBe('danger');
  });

  it('falls back to the raw text for an unknown value (never throws, never matches Object.prototype)', () => {
    expect(orderStatusLabel('constructor' as never)).toBe('constructor');
    expect(orderSourceLabel('__proto__' as never)).toBe('__proto__');
    expect(orderStatusTone('weird' as never)).toBe('neutral');
  });
});

describe('orderActionFor', () => {
  it('describes a button for every status an order can move to', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of nextStatuses(from)) {
        const action = orderActionFor(to);
        expect(action.label, `${from}->${to}`).toMatch(/\S/);
        expect(action.title).toMatch(/\?$/);
        expect(action.confirm).toMatch(/\S/);
      }
    }
  });

  it('asks for an optional note when cancelling, refusing or returning only', () => {
    expect(ORDER_STATUSES.filter((s) => orderActionFor(s).askNote)).toEqual(['cancelled', 'refused', 'returned']);
  });

  it('marks the destructive actions as danger', () => {
    expect(orderActionFor('confirmed').tone).toBe('primary');
    expect(orderActionFor('shipped').tone).toBe('primary');
    expect(orderActionFor('delivered').tone).toBe('primary');
    for (const s of ['cancelled', 'refused', 'returned'] as const) expect(orderActionFor(s).tone).toBe('danger');
  });
});

describe('formatting', () => {
  it('groups a phone number in pairs', () => {
    expect(formatPhone('0612345678')).toBe('06 12 34 56 78');
    expect(formatPhone('weird')).toBe('weird');
  });

  it('labels the delivery mode and the shade', () => {
    expect(deliveryModeLabel('desk')).toBe('Stop Desk (retrait au bureau)');
    expect(deliveryModeLabel('home')).toBe('À domicile');
    expect(shadeLabel('*02')).toBe('Teinte *02');
  });
});

describe('French messages', () => {
  it('explains an invalid transition', () => {
    expect(apiMessage('invalid_transition')).toBe('Ce changement de statut n’est pas possible.');
  });
  it('explains the rate limit and the idempotency conflict', () => {
    expect(apiMessage('too_many_attempts')).toMatch(/Trop de tentatives/);
    expect(apiMessage('idempotency_conflict')).toMatch(/\S/);
    expect(apiMessage('idempotency_conflict')).not.toBe(apiMessage('some_unknown_code'));
  });
  it('labels the order audit actions', () => {
    expect(auditActionLabel('order.status_changed')).toBe('Statut de commande modifié');
    expect(auditActionLabel('order.notes_updated')).toBe('Notes de commande modifiées');
    expect(auditActionLabel('order.created_manual')).toBe('Commande saisie manuellement');
  });
});

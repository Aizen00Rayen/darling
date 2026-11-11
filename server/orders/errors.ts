import type { OrderStatus } from '@/shared';
import { HttpFailure } from '../admin/errors';

/** The status machine refuses this change (also when `to` is the status the order already has). Answers 409. */
export class InvalidTransitionError extends HttpFailure {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(409, 'invalid_transition');
    this.name = 'InvalidTransitionError';
  }
}

/** The same Idempotency-Key was used for a different customer. Answers 409. */
export const idempotencyConflict = () => new HttpFailure(409, 'idempotency_conflict');

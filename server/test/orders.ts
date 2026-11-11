import type { OrderInput } from '@/lib/order-schema';
import type { OrderStatus } from '@/shared';
import type { OrderActor } from '../orders/types';
import { seedUser, type TestApp } from './app';

/** A valid storefront order (Stop Desk in Alger, 2 x Wet Kiss: 3300 x 2 + 300 = 6900 DA). */
export function orderInput(over: Partial<OrderInput> = {}): OrderInput {
  return {
    productSlug: 'wet-kiss',
    shadeCode: '*02',
    quantity: 2,
    fullName: 'Amel B',
    phone: '0612345678',
    wilayaCode: 16,
    commune: 'Hydra',
    mode: 'desk',
    ...over,
  };
}

/** A super manager holding the given permissions (default orders.read + orders.write), as an order actor. */
export async function seedStaff(app: TestApp, permissions: ('orders.read' | 'orders.write')[] = ['orders.read', 'orders.write']): Promise<OrderActor> {
  const u = await seedUser(app, { role: 'super_manager', permissions });
  return { userId: u.id, ip: '10.9.9.9', requestId: 'req-test' };
}

/** Puts an order straight into a status (test setup only: bypasses the machine, timestamps and history). */
export function forceStatus(app: TestApp, id: string, status: OrderStatus): void {
  app.db.run('UPDATE orders SET status = ? WHERE id = ?', status, id);
}

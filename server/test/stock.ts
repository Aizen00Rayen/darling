import type { Db } from '../db/sqlite';
import { ensureDefaultProduct } from '../products/db';
import { insertMovement } from '../inventory/stock';

/** Test helper: receives `quantity` extra units of a product (default Wet Kiss) into the unallocated pool, ledger and total in step. */
export function addStock(db: Db, quantity: number, slug = 'wet-kiss'): void {
  ensureDefaultProduct(db);
  const p = db.get<{ id: string }>('SELECT id FROM products WHERE slug = ?', slug);
  if (!p) throw new Error(`unknown product ${slug}`);
  insertMovement(db, { productId: p.id, shadeCode: '', delta: quantity, reason: 'purchase', at: Date.now() });
  db.run('UPDATE products SET stock = stock + ? WHERE id = ?', quantity, p.id);
}

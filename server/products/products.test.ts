import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test/db';
import type { Db } from '../db/sqlite';
import { createProduct, ensureDefaultProduct, listProducts, readProductById, readProductBySlug, updateProduct } from './db';
import { createProductTemplate } from '@/shared/products';

let db: Db;
const actor = { userId: 'u1', ip: '127.0.0.1', requestId: 'req1' };
const NOW = 1_700_000_000_000;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe('products db', () => {
  it('ensures default wet-kiss product is seeded', () => {
    ensureDefaultProduct(db, NOW);
    const product = readProductBySlug(db, 'wet-kiss');
    expect(product).not.toBeNull();
    expect(product?.name).toBe('Wet Kiss');
    expect(product?.price).toBe(3300);
    expect(product?.shades.length).toBe(4);
  });

  it('lists products including default', () => {
    const list = listProducts(db);
    expect(list.some((p) => p.slug === 'wet-kiss')).toBe(true);
  });

  it('creates a custom product and reads it back', () => {
    const template = createProductTemplate('Velvet Gloss', 'velvet-gloss', 3500);
    const summary = createProduct(db, actor, template, NOW);

    expect(summary.name).toBe('Velvet Gloss');
    expect(summary.slug).toBe('velvet-gloss');
    expect(summary.price).toBe(3500);

    const read = readProductBySlug(db, 'velvet-gloss');
    expect(read).not.toBeNull();
    expect(read?.name).toBe('Velvet Gloss');
    expect(read?.price).toBe(3500);
    expect(read?.shades.length).toBe(template.shades.length);

    const byId = readProductById(db, summary.id);
    expect(byId?.product.name).toBe('Velvet Gloss');
  });

  it('updates a custom product', () => {
    const template = createProductTemplate('Velvet Gloss', 'velvet-gloss', 3500);
    const summary = createProduct(db, actor, template, NOW);

    const updated = updateProduct(db, actor, summary.id, { price: 3800, stock: 45 }, NOW + 1000);
    expect(updated.price).toBe(3800);
    expect(updated.stock).toBe(45);

    const read = readProductBySlug(db, 'velvet-gloss');
    expect(read?.price).toBe(3800);
    expect(read?.stock).toBe(45);
  });
});

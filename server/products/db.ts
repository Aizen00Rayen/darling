import type { Product } from '@/data/products';
import { defaultProduct } from '@/data/products';
import type { ProductInput, ProductSummary } from '@/shared/products';
import type { Db } from '../db/sqlite';
import { recordAudit } from '../audit';
import { newId } from '../ids';
import { isUniqueViolation, notFound, validation } from '../admin/errors';

export interface ProductActor {
  userId: string;
  ip: string;
  requestId: string;
}

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  price: number;
  stock: number;
  max_quantity: number;
  is_active: number;
  is_default: number;
  data: string;
  created_at: number;
  updated_at: number;
}

export function ensureDefaultProduct(db: Db, now = Date.now()): void {
  const existing = db.get<{ id: string }>('SELECT id FROM products WHERE slug = ?', defaultProduct.slug);
  if (!existing) {
    const id = '01931a00-0000-7000-8000-000000000001';
    db.run(
      `INSERT OR IGNORE INTO products (id, slug, name, price, stock, max_quantity, is_active, is_default, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      defaultProduct.slug,
      defaultProduct.name,
      defaultProduct.price,
      100,
      defaultProduct.maxQuantity,
      1,
      1,
      JSON.stringify(defaultProduct),
      now,
      now,
    );
  }
}

function rowToProduct(row: ProductRow): Product {
  try {
    const parsed = JSON.parse(row.data) as Product;
    return {
      ...parsed,
      slug: row.slug,
      name: row.name,
      price: row.price,
      maxQuantity: row.max_quantity,
      stock: row.stock,
    };
  } catch {
    return {
      ...defaultProduct,
      slug: row.slug,
      name: row.name,
      price: row.price,
      maxQuantity: row.max_quantity,
      stock: row.stock,
    };
  }
}

function rowToSummary(row: ProductRow): ProductSummary {
  let shadesCount = 1;
  try {
    const parsed = JSON.parse(row.data);
    if (Array.isArray(parsed.shades)) shadesCount = parsed.shades.length;
  } catch {
    // fallback
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    price: row.price,
    stock: row.stock,
    maxQuantity: row.max_quantity,
    isActive: row.is_active === 1,
    isDefault: row.is_default === 1,
    shadesCount,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function listProducts(db: Db): ProductSummary[] {
  ensureDefaultProduct(db);
  const rows = db.all<ProductRow>('SELECT * FROM products ORDER BY is_default DESC, created_at DESC');
  return rows.map(rowToSummary);
}

export function readProductBySlug(db: Db, slug: string): Product | null {
  ensureDefaultProduct(db);
  const row = db.get<ProductRow>('SELECT * FROM products WHERE slug = ?', slug);
  if (row) return rowToProduct(row);
  if (slug === defaultProduct.slug) return defaultProduct;
  return null;
}

export function readProductById(db: Db, id: string): { product: Product; summary: ProductSummary } | null {
  ensureDefaultProduct(db);
  const row = db.get<ProductRow>('SELECT * FROM products WHERE id = ?', id);
  if (!row) return null;
  return { product: rowToProduct(row), summary: rowToSummary(row) };
}

export function createProduct(db: Db, actor: ProductActor, input: ProductInput, now: number): ProductSummary {
  ensureDefaultProduct(db);
  const id = newId({ now: () => now });
  const data = JSON.stringify(input);

  try {
    db.run(
      `INSERT INTO products (id, slug, name, price, stock, max_quantity, is_active, is_default, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.slug,
      input.name,
      input.price,
      input.stock,
      input.maxQuantity,
      input.isActive ? 1 : 0,
      input.isDefault ? 1 : 0,
      data,
      now,
      now,
    );
  } catch (err) {
    if (isUniqueViolation(err, 'products.slug')) {
      throw validation({ slug: 'Un produit avec cet identifiant URL existe déjà.' });
    }
    throw err;
  }

  recordAudit(db, {
    actorUserId: actor.userId,
    action: 'product.created',
    entityType: 'product',
    entityId: id,
    after: { slug: input.slug, name: input.name, price: input.price, stock: input.stock },
    ip: actor.ip,
    requestId: actor.requestId,
    at: now,
  });

  const row = db.get<ProductRow>('SELECT * FROM products WHERE id = ?', id);
  return rowToSummary(row!);
}

export function updateProduct(db: Db, actor: ProductActor, id: string, input: Partial<ProductInput>, now: number): ProductSummary {
  ensureDefaultProduct(db);
  const existing = db.get<ProductRow>('SELECT * FROM products WHERE id = ?', id);
  if (!existing) throw notFound();

  let mergedData: ProductInput;
  try {
    const current = JSON.parse(existing.data) as ProductInput;
    mergedData = { ...current, ...input };
  } catch {
    mergedData = { ...input } as ProductInput;
  }

  const slug = input.slug ?? existing.slug;
  const name = input.name ?? existing.name;
  const price = input.price ?? existing.price;
  const stock = input.stock ?? existing.stock;
  const maxQuantity = input.maxQuantity ?? existing.max_quantity;
  const isActive = input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active;
  const isDefault = input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : existing.is_default;
  const data = JSON.stringify(mergedData);

  try {
    db.run(
      `UPDATE products SET slug = ?, name = ?, price = ?, stock = ?, max_quantity = ?, is_active = ?, is_default = ?, data = ?, updated_at = ?
       WHERE id = ?`,
      slug,
      name,
      price,
      stock,
      maxQuantity,
      isActive,
      isDefault,
      data,
      now,
      id,
    );
  } catch (err) {
    if (isUniqueViolation(err, 'products.slug')) {
      throw validation({ slug: 'Un produit avec cet identifiant URL existe déjà.' });
    }
    throw err;
  }

  recordAudit(db, {
    actorUserId: actor.userId,
    action: 'product.updated',
    entityType: 'product',
    entityId: id,
    before: { slug: existing.slug, name: existing.name, price: existing.price, stock: existing.stock },
    after: { slug, name, price, stock },
    ip: actor.ip,
    requestId: actor.requestId,
    at: now,
  });

  const row = db.get<ProductRow>('SELECT * FROM products WHERE id = ?', id);
  return rowToSummary(row!);
}

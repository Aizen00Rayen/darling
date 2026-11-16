-- 0005_inventory: append-only stock ledger. products.stock stays the cached total (sum of all movements for the
-- product); the per-shade breakdown is the sum of movements per shade_code. shade_code '' is the "unallocated" pool:
-- stock whose shade has not been specified (opening balances, bulk receipts). Timestamps are epoch milliseconds (UTC).

ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER NOT NULL DEFAULT 10
  CHECK (typeof(low_stock_threshold) = 'integer' AND low_stock_threshold >= 0);

CREATE TABLE stock_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     TEXT NOT NULL REFERENCES products (id),
  shade_code     TEXT NOT NULL DEFAULT '' CHECK (length(shade_code) <= 20),
  -- Signed: positive adds stock, negative removes it.
  delta          INTEGER NOT NULL CHECK (typeof(delta) = 'integer' AND delta <> 0),
  reason         TEXT NOT NULL
                 CHECK (reason IN ('initial', 'purchase', 'sale_website', 'sale_offsite', 'return', 'damage', 'adjustment')),
  -- Where an off-site sale happened (instagram, whatsapp, facebook, direct, other); NULL otherwise.
  channel        TEXT CHECK (channel IS NULL OR channel IN ('website', 'affiliate', 'instagram', 'whatsapp', 'facebook', 'direct', 'other')),
  order_id       TEXT REFERENCES orders (id),
  -- Sale price per unit (sales) or purchase cost per unit (purchases), whole dinars; NULL when not recorded.
  unit_price     INTEGER CHECK (unit_price IS NULL OR (typeof(unit_price) = 'integer' AND unit_price >= 0)),
  note           TEXT CHECK (note IS NULL OR length(note) <= 500),
  -- No foreign key on actor_user_id (like audit_log): ledger rows outlive users.
  actor_user_id  TEXT,
  at             INTEGER NOT NULL
);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, shade_code);
CREATE INDEX stock_movements_order_idx ON stock_movements (order_id);
CREATE INDEX stock_movements_at_idx ON stock_movements (at);

CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

-- Opening balances: the current per-product stock becomes one unallocated 'initial' movement.
INSERT INTO stock_movements (product_id, shade_code, delta, reason, note, at)
SELECT id, '', stock, 'initial', 'Stock initial repris à la mise en place', updated_at FROM products WHERE stock > 0;

-- 0002_orders: orders and their status history. All money is whole dinars (INTEGER). Price, delivery fee, product and
-- shade are SNAPSHOTS taken when the order is created and never recomputed. Timestamps are epoch milliseconds (UTC).
-- Affiliate attribution columns arrive with 0003 (ALTER TABLE).

CREATE TABLE orders (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  -- DL-<YY in Algiers>-<seq padded to 6>, built in the same transaction as the insert.
  number           TEXT NOT NULL UNIQUE,
  idempotency_key  TEXT UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 64),
  status           TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refused', 'returned')),
  source           TEXT NOT NULL
                   CHECK (source IN ('website', 'affiliate', 'instagram', 'whatsapp', 'facebook', 'direct', 'other')),
  customer_name    TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  -- Normalised local form, e.g. 0612345678.
  phone            TEXT NOT NULL CHECK (phone GLOB '0[567][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  wilaya_code      INTEGER NOT NULL CHECK (wilaya_code BETWEEN 1 AND 99),
  wilaya_name      TEXT NOT NULL,
  commune          TEXT NOT NULL CHECK (length(commune) BETWEEN 1 AND 120),
  address          TEXT CHECK (address IS NULL OR length(address) <= 200),
  delivery_mode    TEXT NOT NULL CHECK (delivery_mode IN ('desk', 'home')),
  product_slug     TEXT NOT NULL,
  product_name     TEXT NOT NULL,
  shade_code       TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
  unit_price       INTEGER NOT NULL CHECK (typeof(unit_price) = 'integer' AND unit_price >= 0),
  delivery_fee     INTEGER NOT NULL CHECK (typeof(delivery_fee) = 'integer' AND delivery_fee >= 0),
  total            INTEGER NOT NULL CHECK (typeof(total) = 'integer' AND total >= 0),
  internal_notes   TEXT CHECK (internal_notes IS NULL OR length(internal_notes) <= 2000),
  -- Staff member who entered the order by hand; NULL for storefront orders.
  created_by       TEXT REFERENCES users (id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  confirmed_at     INTEGER,
  shipped_at       INTEGER,
  delivered_at     INTEGER,
  -- When the order reached a final unsuccessful status (cancelled, refused or returned).
  closed_at        INTEGER,
  CHECK (total = unit_price * quantity + delivery_fee),
  CHECK ((delivery_mode = 'home') = (address IS NOT NULL))
);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_created_at_idx ON orders (created_at);
CREATE INDEX orders_phone_idx ON orders (phone);

CREATE TABLE order_status_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       TEXT NOT NULL REFERENCES orders (id),
  from_status    TEXT CHECK (from_status IS NULL OR from_status IN ('new', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refused', 'returned')),
  to_status      TEXT NOT NULL CHECK (to_status IN ('new', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refused', 'returned')),
  actor_user_id  TEXT REFERENCES users (id),
  note           TEXT CHECK (note IS NULL OR length(note) <= 500),
  at             INTEGER NOT NULL
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, id);

-- The history is a record: no edits, no deletions.
CREATE TRIGGER order_status_history_no_update BEFORE UPDATE ON order_status_history
BEGIN
  SELECT RAISE(ABORT, 'order_status_history is append-only');
END;
CREATE TRIGGER order_status_history_no_delete BEFORE DELETE ON order_status_history
BEGIN
  SELECT RAISE(ABORT, 'order_status_history is append-only');
END;

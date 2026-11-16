-- 0006_finance: purchase cost for profit reporting, and soft deletion of products and orders.
-- cost_price is the real (purchase) unit cost in whole dinars, kept as a weighted average when stock is received at a cost.
-- orders.unit_cost snapshots that cost when the order is created, like unit_price, so later cost changes never rewrite history.
-- Deleted rows are hidden, never removed: ledgers and audit rows must stay consistent.

ALTER TABLE products ADD COLUMN cost_price INTEGER NOT NULL DEFAULT 0 CHECK (typeof(cost_price) = 'integer' AND cost_price >= 0);
ALTER TABLE products ADD COLUMN deleted_at INTEGER;
ALTER TABLE orders ADD COLUMN unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (typeof(unit_cost) = 'integer' AND unit_cost >= 0);
ALTER TABLE orders ADD COLUMN deleted_at INTEGER;
ALTER TABLE stock_movements ADD COLUMN unit_cost INTEGER CHECK (unit_cost IS NULL OR (typeof(unit_cost) = 'integer' AND unit_cost >= 0));
CREATE INDEX orders_deleted_idx ON orders (deleted_at);

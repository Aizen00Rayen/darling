-- 0004_products: product catalog and stock.
-- Stores custom products created by admins while preserving Wet Kiss as the foundational default product.
-- Money is whole dinars (INTEGER). Timestamps are epoch milliseconds (UTC).

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80 AND slug NOT GLOB '*[^a-z0-9-]*'),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  price         INTEGER NOT NULL CHECK (typeof(price) = 'integer' AND price >= 0),
  stock         INTEGER NOT NULL DEFAULT 100 CHECK (typeof(stock) = 'integer' AND stock >= 0),
  max_quantity  INTEGER NOT NULL DEFAULT 20 CHECK (typeof(max_quantity) = 'integer' AND max_quantity >= 1),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  data          TEXT NOT NULL CHECK (json_valid(data)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX products_slug_idx ON products (slug);
CREATE INDEX products_active_idx ON products (is_active);

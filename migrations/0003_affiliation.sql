-- 0003_affiliation: influenceuse profiles and codes, link clicks, order attribution, commissions, adjustments, payouts.
-- Money is whole dinars (INTEGER, typeof-checked). Timestamps are epoch milliseconds (UTC). The commission amount is a
-- SNAPSHOT of the setting at the time the order was created and never recomputed.

-- One row per user who has ever been an influenceuse. Never deleted: a code is never reused, even after a role change.
CREATE TABLE affiliate_profiles (
  user_id          TEXT PRIMARY KEY REFERENCES users (id),
  code             TEXT NOT NULL UNIQUE CHECK (code GLOB '[A-Z][A-Z][A-Z][0-9][0-9][0-9]*' AND code NOT GLOB '*[^A-Z0-9]*'),
  -- The sous-manager who currently manages her; it only affects FUTURE orders (orders snapshot their own manager).
  manager_user_id  TEXT REFERENCES users (id),
  created_at       INTEGER NOT NULL
);
CREATE INDEX affiliate_profiles_manager_idx ON affiliate_profiles (manager_user_id);

-- ip_hash is an HMAC of the client address (never the address itself).
CREATE TABLE affiliate_clicks (
  id                TEXT PRIMARY KEY,
  affiliate_user_id TEXT NOT NULL REFERENCES users (id),
  ip_hash           TEXT NOT NULL,
  at                INTEGER NOT NULL,
  referrer_host     TEXT,
  landing_path      TEXT NOT NULL,
  order_id          TEXT
);
CREATE INDEX affiliate_clicks_affiliate_at_idx ON affiliate_clicks (affiliate_user_id, at);

ALTER TABLE orders ADD COLUMN affiliate_user_id TEXT REFERENCES users (id);
ALTER TABLE orders ADD COLUMN manager_user_id TEXT REFERENCES users (id);
ALTER TABLE orders ADD COLUMN attribution_click_id TEXT;
ALTER TABLE orders ADD COLUMN self_referral INTEGER NOT NULL DEFAULT 0 CHECK (self_referral IN (0, 1));
CREATE INDEX orders_affiliate_idx ON orders (affiliate_user_id);
CREATE INDEX orders_manager_idx ON orders (manager_user_id);

CREATE TABLE payouts (
  id                   TEXT PRIMARY KEY,
  beneficiary_user_id  TEXT NOT NULL REFERENCES users (id),
  amount               INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
  method               TEXT NOT NULL CHECK (method IN ('cash', 'ccp', 'baridimob', 'bank', 'other')),
  reference            TEXT CHECK (reference IS NULL OR length(reference) <= 100),
  -- Start of the Algiers calendar day the money was handed over.
  paid_at              INTEGER NOT NULL,
  note                 TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by           TEXT NOT NULL REFERENCES users (id),
  created_at           INTEGER NOT NULL
);
CREATE INDEX payouts_beneficiary_idx ON payouts (beneficiary_user_id, paid_at);

CREATE TABLE commissions (
  id                   TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES orders (id),
  beneficiary_user_id  TEXT NOT NULL REFERENCES users (id),
  kind                 TEXT NOT NULL CHECK (kind IN ('affiliate', 'manager')),
  amount               INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount >= 0),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validated', 'paid', 'cancelled')),
  on_hold              INTEGER NOT NULL DEFAULT 0 CHECK (on_hold IN (0, 1)),
  hold_reason          TEXT CHECK (hold_reason IS NULL OR length(hold_reason) <= 200),
  validated_at         INTEGER,
  cancelled_at         INTEGER,
  cancel_reason        TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  payout_id            TEXT REFERENCES payouts (id),
  created_at           INTEGER NOT NULL,
  -- A commission is paid exactly when a payout carries it.
  CHECK ((status = 'paid') = (payout_id IS NOT NULL)),
  UNIQUE (order_id, kind)
);
CREATE INDEX commissions_beneficiary_idx ON commissions (beneficiary_user_id, status);
CREATE INDEX commissions_status_idx ON commissions (status, on_hold);

-- Negative = clawback (a commission that was already paid and whose order came back). Netted in the next payout.
CREATE TABLE commission_adjustments (
  id                   TEXT PRIMARY KEY,
  beneficiary_user_id  TEXT NOT NULL REFERENCES users (id),
  amount               INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount <> 0),
  reason               TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  order_id             TEXT REFERENCES orders (id),
  payout_id            TEXT REFERENCES payouts (id),
  created_at           INTEGER NOT NULL,
  created_by           TEXT REFERENCES users (id)
);
CREATE INDEX commission_adjustments_beneficiary_idx ON commission_adjustments (beneficiary_user_id, payout_id);
-- A return claws a commission back once, however many times the code runs.
CREATE UNIQUE INDEX commission_adjustments_return_uq ON commission_adjustments (order_id, beneficiary_user_id) WHERE reason = 'retour';

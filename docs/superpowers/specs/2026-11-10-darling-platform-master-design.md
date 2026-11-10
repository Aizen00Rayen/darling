# DARLING* platform — master design

Date: 2026-11-10
Status: awaiting review
Source requirements: `DARLING_CAHIER_DES_CHARGES_FONCTIONNEL.pdf` (17 pages, referred to below as **CDC §n**)
Builds on: `2026-11-09-darling-storefront-clone-design.md` (the Next.js storefront on branch `feat/storefront-clone`)

## 1. Goal

One platform from which DARLING* runs its whole business: the public storefront,
the affiliate program, the CRM, products and stock, commissions and payouts,
expenses, profitability, dashboards and reports. Every sale, expense,
commission and stock movement is recorded once and is traceable (CDC §17).

Three portals share one API and one database:

| Portal | Users | Purpose |
|---|---|---|
| `/admin` | Super Managers | Control centre: everything (CDC §2.3) |
| `/manager` | Sous-manager | Their team of influenceuses (CDC §2.2) |
| `/affiliate` | Influenceuses | Their own link, clicks, orders, commissions (CDC §2.1) |

The storefront stays the public face. Its products, pictures, videos, shades,
prices and copy come from the database and are managed from `/admin`.

## 2. Decisions taken with the owner

| Topic | Decision |
|---|---|
| Backend | Separate Node.js service in TypeScript |
| Structure | Modular monolith: one API, one PostgreSQL database, one Next.js web app |
| Validated sale | A sale is **validée** when its order reaches **Livrée**. A later **Retournée** cancels it |
| Stock deduction | On **Confirmée**. Restored on Annulée, Refusée or Retournée. Every change is a stock movement |
| Visual identity | All portals reuse the storefront's fonts, palette and glass components |
| Interface language | French |

Assumptions to confirm are listed in §19 (open decisions), each with the
default this design uses until answered.

## 3. Architecture

### 3.1 Repository layout (pnpm workspaces)

```
apps/
  api/        Fastify API. All business rules, authorization and persistence
  web/        Next.js app: storefront + /admin + /manager + /affiliate
packages/
  shared/     Zod schemas, enums, permission catalogue, pricing and money helpers
  ui/         Darling design system: tokens, ported storefront CSS, portal components
infra/
  docker-compose.yml   postgres, minio (S3), mailpit (dev mail)
  backup/              backup and restore scripts
docs/
```

The current storefront (repo root) moves into `apps/web` in sub-project 1.

### 3.2 Runtime

| Concern | Choice | Why |
|---|---|---|
| Node | 22 LTS (upgrade from the installed 20.18, which reached end of life in April 2026) | Supported runtime; also unblocks current Vitest |
| API framework | Fastify 5 + `fastify-type-provider-zod` | Fast, schema-validated routes, mature plugins (rate limit, helmet, cookies, multipart) |
| Database | PostgreSQL 16+ | Relational data, transactions, constraints, row locking for stock |
| Data access | Drizzle ORM + versioned SQL migrations | Explicit SQL, typed queries, constraints live in migrations |
| Background jobs | pg-boss (queue in Postgres) | Recurring expenses, notifications, exports, without adding Redis |
| Files | S3-compatible object storage (MinIO in dev; Cloudflare R2 or any S3 in prod) | Images and videos never stored in the database |
| Image processing | sharp | Validate, strip metadata, generate WebP sizes |
| Email | SMTP adapter (Mailpit in dev, any provider in prod) | Invites and password resets |
| Excel / PDF exports | exceljs; PDF from server-rendered HTML | CDC §12 formats |
| Logging | pino, JSON, request IDs | Traceable incidents |
| Tests | Vitest (unit + API integration on a real Postgres), Playwright (end-to-end) | §16 |

### 3.3 Request path

The browser only talks to the web app's origin. Next.js rewrites `/api/*` to
the Fastify service, so session cookies are first-party and same-origin. The
API is not exposed on a second public domain.

```
browser ──► web (Next.js) ──/api/*──► api (Fastify) ──► PostgreSQL
                                          ├──► object storage
                                          └──► pg-boss workers (same process in v1)
```

Server components in the web app call the API server-to-server with the
user's session cookie forwarded. No business rule or permission check lives
only in the web app.

### 3.4 Module boundaries inside the API

Each module owns its tables and exposes a service interface. Other modules
call the service, never the tables.

`auth` · `users` · `settings` · `audit` · `catalog` · `media` · `stock` ·
`delivery` · `clients` · `orders` · `attribution` · `commissions` ·
`payouts` · `payments` · `expenses` · `finance` · `reports` · `notifications`

Cross-module effects of an order status change (stock, commissions,
notifications) run inside one database transaction, orchestrated by the
`orders` module (§9.3).

## 4. Roles, permissions and data scope

### 4.1 Roles

| Role | Code | Scope of data |
|---|---|---|
| Super Manager | `super_manager` | Everything, limited by permissions granted |
| Sous-manager | `sub_manager` | Influenceuses whose `manager_id` is them, and their own commissions |
| Influenceuse | `affiliate` | Only their own data |

A Super Manager with the **owner** flag holds every permission and is the
only one who can create, change or remove other Super Managers. At least one
active owner must always exist (enforced by the API).

### 4.2 Permission catalogue (granted to Super Managers individually)

| Permission | Allows |
|---|---|
| `users.manage` | Create, edit, suspend sous-managers and influenceuses; reset their access |
| `orders.read` | See all orders and clients |
| `orders.write` | Create and edit orders, change status, assign a responsable |
| `orders.override` | Backward status changes, manual attribution, editing a delivered order (reason required) |
| `clients.merge` | Merge duplicate client files |
| `catalog.write` | Products, shades, media, page content, categories |
| `stock.write` | Stock entries, losses, damage, adjustments |
| `commissions.manage` | Commission rules, cancel or adjust commissions |
| `payouts.manage` | Create commission payouts and mark them paid |
| `finance.read` | Revenue, costs, margins, profit, finance dashboard |
| `expenses.write` | Expenses, recurring expenses, supplier payments |
| `reports.export` | Generate and download reports and exports |
| `settings.manage` | Delivery fees, sales channels, expense categories, attribution window, company settings |
| `audit.read` | Audit log, login log |

Roles `sub_manager` and `affiliate` have fixed capabilities (§4.3); permissions
cannot widen them.

### 4.3 Capability matrix

R = read, W = write, — = no access. "Team" = influenceuses managed by this sous-manager.

| Resource | Influenceuse | Sous-manager | Super Manager |
|---|---|---|---|
| Own profile, password | R/W | R/W | R/W |
| Influenceuse accounts | own (R) | team (R/W, create, suspend) | all (`users.manage`) |
| Affiliate links | own (R) | team (R/W) | all |
| Clicks | own (R, aggregated) | team (R, aggregated) | all |
| Attributed orders | own (R, client masked) | team (R, client masked) | all (`orders.read`) |
| Commissions | own (R) | team + own (R) | all (`commissions.manage`) |
| Payouts | own (R) | own + team (R) | all (`payouts.manage`) |
| DARLING* guidelines | R | R/W for team | R/W |
| Clients, full orders | — | — | `orders.read` / `orders.write` |
| Products, stock | — | — | `catalog.write` / `stock.write` |
| Expenses, finance | — | — | `finance.read` / `expenses.write` |
| Reports, exports | — | team performance only | `reports.export` |
| Settings, audit | — | — | `settings.manage` / `audit.read` |

**Client masking** (data minimisation): influenceuses and the sous-manager see
order number, date, status, products, amount and wilaya, plus the client's
first name and initial. Never the phone number or address.

### 4.4 Enforcement rules

1. Every API route declares the permission or role it needs. A route without
   a declaration fails the build-time route audit test (§16).
2. Scope is applied in the query (`WHERE affiliate_id = :me`, `WHERE manager_id = :me`),
   never by filtering results after loading them.
3. Access to another user's record by ID returns 404, not 403, so IDs cannot be probed.
4. The web app hides what a user cannot do, but the API is the only gate.
5. Role, permission or status changes revoke that user's other sessions immediately.

## 5. Authentication and account security

| Item | Rule |
|---|---|
| Account creation | No public sign-up. Super Managers create anyone; sous-managers create influenceuses in their team. An **invite email** carries a single-use link to set a password |
| Passwords | argon2id. Minimum 10 characters, checked against a list of common passwords. Never logged |
| Sessions | Random 256-bit token, stored hashed in `sessions`. Cookie `__Host-dl_session`: httpOnly, Secure, SameSite=Lax, path `/`. Idle timeout 12 h for portals; absolute 30 days with "remember me", otherwise 24 h |
| CSRF | SameSite=Lax plus an `Origin` check on every non-GET request; mutating requests must send `X-Requested-With` |
| Login throttling | 5 attempts per minute per IP; account locked 15 minutes after 10 consecutive failures; same response for unknown email and wrong password |
| Two-factor | TOTP available to everyone, **required for Super Managers** (setting `security.require_2fa_super_managers`, default on) |
| Password reset | Single-use token, stored hashed, valid 30 minutes. Reset revokes all sessions |
| Login log | Every attempt: user (if known), email tried, IP, user agent, success, reason, time (CDC §10) |
| Suspension | Suspended users cannot log in; their affiliate links stop attributing new clicks; existing commissions are kept |

## 6. Data model

All money is stored as **whole dinars in `integer`** columns (no floats). All
timestamps are `timestamptz`; reporting day boundaries use **Africa/Algiers**.
Primary keys are UUIDv7 unless stated. Every table has `created_at` and,
where editable, `updated_at`.

### 6.1 Identity and access

```
users            id, email (citext unique), password_hash, full_name, phone,
                 role (super_manager|sub_manager|affiliate),
                 status (invited|active|suspended|deactivated),
                 is_owner bool, totp_secret_enc, totp_enabled,
                 failed_logins, locked_until, last_login_at
user_permissions user_id, permission              PK(user_id, permission)
sessions         id, token_hash unique, user_id, ip, user_agent,
                 created_at, last_seen_at, expires_at, revoked_at
auth_tokens      id, user_id, type (invite|password_reset), token_hash,
                 expires_at, used_at
login_events     id bigserial, user_id null, email_tried, ip, user_agent,
                 success, reason, at
audit_log        id bigserial, actor_user_id null, action, entity_type,
                 entity_id, before jsonb, after jsonb, reason, ip, request_id, at
settings         key, value jsonb, updated_by, updated_at
```

`audit_log` is append-only: the application's database role has `INSERT` and
`SELECT` only, and a trigger rejects `UPDATE` and `DELETE`.

### 6.2 Affiliation

```
affiliate_profiles  user_id PK, code unique (e.g. AYA001), manager_id → users(sub_manager) null,
                    instagram_handle, payout_method (cash|ccp|baridimob|bank),
                    payout_details_enc, commission_override null, notes
campaigns           id, name, code unique, starts_at, ends_at, active
affiliate_links     id, affiliate_id, code unique, campaign_id null,
                    target_path default '/', active, created_by
clicks              id bigserial, link_id, affiliate_id, visitor_id,
                    at, referrer_host, utm_source, utm_medium, utm_campaign,
                    landing_path, ip_hash, ua_hash, is_bot, order_id null
announcements       id, author_id, audience (all|team), team_manager_id null,
                    title, body, pinned, published_at      ← "informations et consignes"
```

### 6.3 Catalogue, media and stock

```
categories        id, name, slug unique, position
products          id, slug unique, name, status (draft|active|archived),
                  category_id, description, price, purchase_cost, packaging_cost,
                  max_quantity_per_order default 20, featured bool,
                  page_content jsonb, seo_title, seo_description
product_variants  id, product_id, sku unique, name (e.g. "*01"), color_hex,
                  price null, purchase_cost null,       ← override product values
                  stock_on_hand integer CHECK (stock_on_hand >= 0),
                  low_stock_threshold, active, position
media             id, kind (image|video), visibility (public|private),
                  storage_key, mime, bytes, width, height, duration_s,
                  derivatives jsonb, poster_media_id null, uploaded_by
product_media     product_id, media_id, role (gallery|editorial|effect_video|ritual_video|og),
                  variant_id null, position, alt, thumb_label, uncropped bool
stock_movements   id bigserial, variant_id, delta integer, balance_after,
                  reason (stock_in|sale|sale_reversal|return|loss|damage|adjustment),
                  order_id null, unit_cost null, note, actor_user_id, at
```

`page_content` holds the storefront sections already defined by the clone's
`Product` type (eyebrow, tagline, description, perks, effect, layering,
ritual, FAQ, final call to action) and references media by ID. It is
validated by a Zod schema in `packages/shared`.

**Stock** is per shade (variant). `stock_on_hand` changes only through
`stock_movements`, inside the same transaction, with the variant row locked
(`SELECT … FOR UPDATE`). The CHECK constraint makes overselling impossible.

### 6.4 Delivery, clients, orders

```
wilayas           code PK 1..58, name, home_fee, desk_fee null, active
sales_channels    id, code unique, name, kind (website|affiliate|instagram|
                  whatsapp|social|direct|other), active
clients           id, full_name, phone (normalised, unique), phone_alt,
                  email, wilaya_code, commune, address,
                  acquisition_channel_id, first_order_at, notes
orders            id, number unique (DL-26-000123), client_id,
                  channel_id NOT NULL, affiliate_id null, manager_id null,
                  attribution_click_id null, attribution_kind (click|manual|none),
                  status, payment_status (unpaid|paid|refunded),
                  delivery_mode (desk|home), wilaya_code, commune, address,
                  items_total, delivery_fee_charged, delivery_cost_borne,
                  total, assigned_to null, internal_notes,
                  idempotency_key unique null, created_by null,
                  confirmed_at, shipped_at, delivered_at, closed_at
order_items       id, order_id, variant_id, product_name, variant_name, sku,
                  quantity, unit_price, unit_purchase_cost, unit_packaging_cost,
                  line_total                                     ← snapshots
order_status_history  id bigserial, order_id, from_status, to_status,
                  actor_user_id null, note, at
order_payments    id, order_id, amount, method (cod|cash|transfer|other),
                  received_at, reference, recorded_by
```

Sales channels are seeded with the seven sources of CDC §5.1 and can be
extended in settings (CDC §5.1 point 7).

**Client deduplication:** the phone number is normalised (`+213 6…` → `06…`,
spaces removed) and is the identity key. An order from a known phone attaches
to the existing client and updates contact fields only if they were empty;
differences are kept on the order. A merge tool (`clients.merge`) moves orders
from one client to another and records the merge in the audit log.

### 6.5 Commissions and payouts

```
commission_rules  settings keys: commission.affiliate_amount = 300,
                  commission.manager_amount = 200, commission.basis = per_order
commissions       id, order_id, beneficiary_id, kind (affiliate|manager),
                  amount, status (pending|validated|paid|cancelled),
                  on_hold bool, hold_reason,          ← e.g. self-referral review
                  validated_at, cancelled_at, cancel_reason, payout_id null
                  UNIQUE (order_id, kind)
commission_adjustments  id, beneficiary_id, amount (negative = clawback),
                  reason, order_id null, payout_id null, created_by
payouts           id, beneficiary_id, period_start, period_end, amount,
                  method, transaction_ref, paid_at, status (draft|paid),
                  created_by, note
```

### 6.6 Finance

```
expense_categories  id, name, is_merchandise bool, active      ← 10 seeded from CDC §7.2
suppliers           id, name, contact, notes
expenses            id, title, category_id, amount, date, payment_method,
                    supplier_id null, payee, description,
                    receipt_media_id null (private), payment_status (unpaid|paid),
                    paid_at, recurring_id null, created_by
recurring_expenses  id, template fields…, frequency (weekly|monthly|yearly),
                    next_run_on, active
```

### 6.7 Notifications

```
notifications     id, user_id, type, title, body, link, payload jsonb, read_at
```

## 7. Catalogue and storefront (CDC §6, owner request)

### 7.1 What a Super Manager can manage

- **Products:** name, slug, category, status (draft, active, archived),
  description, selling price, purchase cost, packaging cost, maximum quantity
  per order, featured flag, SEO title and description.
- **Shades (variants):** name or code, SKU, colour (hex, shown as the
  swatch), optional price and cost override, stock, low-stock threshold,
  order of display, active flag, and the shade's own render picture.
- **Media:** upload images (JPEG, PNG, WebP; up to 10 MB) and videos (MP4
  H.264 or WebM; up to 100 MB, with a required poster image); reorder the
  gallery; set alt text and thumbnail label; mark a picture "uncropped".
- **Page content:** every text section of the product page, edited in a form
  with a live preview using the real storefront components.
- **Deactivate** rather than delete: a product that has orders can only be
  archived, so order history and reports stay intact.

### 7.2 Upload handling

1. The browser uploads to the API (`multipart`, streamed); size is enforced while streaming.
2. The type is checked from the file's bytes, not its name or declared type.
3. Images are re-encoded with sharp: metadata stripped, WebP derivatives at
   80, 640, 1080 and 1600 px wide.
4. Public media go to the public bucket behind a CDN; expense receipts go to a
   private bucket and are served through short-lived signed URLs (5 minutes)
   after a permission check.
5. Every upload is recorded with the uploader.

### 7.3 Storefront behaviour

| Route | Content |
|---|---|
| `/` | The featured product, using the cloned page template |
| `/produits` | Grid of active products (new) |
| `/p/[slug]` | Any active product, same template |
| `/merci` | Thank-you page, now showing the order number |

- Product data is read from the API's public endpoints and cached; saving a
  product in `/admin` revalidates the affected pages.
- A shade with zero stock is shown as **Épuisé** and cannot be ordered.
- Delivery fees come from the `wilayas` table, editable in settings.
- The storefront order endpoint moves from the clone's Next.js stub
  (`app/api/orders`) to the Fastify API. It is public but rate-limited
  (default 30 orders per hour per IP, configurable, because Algerian mobile
  networks put many customers behind one IP), carries a honeypot field and an
  idempotency key, and prices everything on the server (unchanged principle
  from the clone).

## 8. Affiliation and attribution (CDC §3)

### 8.1 Links

- Each influenceuse gets a **code** (`AYA001` pattern: first three letters of
  her name plus a sequence) and a primary link `darling7.store/?ref=AYA001`.
- Extra links per campaign: `?ref=AYA001&c=RAMADAN26`, or a link to a
  specific product: `/p/wet-kiss?ref=AYA001`.
- The sous-manager or a Super Manager creates and deactivates links.

### 8.2 Recording a click

Middleware in the web app sees `?ref=` on any page and calls the API, which:

1. Resolves the code. An unknown or inactive code records nothing.
2. Flags bots by user agent (bots are stored with `is_bot = true` and excluded from figures).
3. Records the click with time, referrer host, UTM tags, campaign, landing page,
   a visitor ID, and salted hashes of IP and user agent (no raw IP stored).
4. Counts a repeat click from the same visitor on the same link within 30 minutes once.
5. Sets a first-party cookie `dl_ref` holding the click ID, signed with HMAC,
   lasting the attribution window.

### 8.3 Attributing an order

- **Rule:** last valid affiliate click within the attribution window
  (setting `attribution.window_days`, default **30**).
- At order intake the API verifies the cookie signature, the window, and that
  the influenceuse is still active. The order then gets `channel = affiliate`,
  `affiliate_id`, `manager_id` (the influenceuse's manager at that moment) and
  `attribution_click_id`, and the click gets `order_id`.
- An order carries at most one influenceuse (no double attribution).
- **Self-referral guard:** if the client phone equals the influenceuse's phone,
  the order is attributed but its commissions are created `on_hold`, and they
  cannot be validated until a Super Manager with `commissions.manage` releases
  or cancels them.
- **Manual orders** (Instagram, WhatsApp, direct) can be attributed by hand
  with `orders.override` and a reason; this is recorded as `attribution_kind = manual`.

## 9. Orders and CRM (CDC §5)

### 9.1 Creating orders

- **Storefront:** status `new`, channel `website` or `affiliate`.
- **Manual entry form** in `/admin` for Instagram, WhatsApp, other social,
  direct sales and other channels. Channel is mandatory. Phone lookup fills in
  an existing client. Built for fast entry on a phone.

### 9.2 Order statuses and allowed transitions

```
new ──► confirming ──► confirmed ──► prepared ──► shipped ──► delivered ──► returned
 │          │              │             │           │
 └──────────┴──────────────┴─────────────┴──► cancelled
                                                     shipped ──► refused
```

French labels: Nouvelle commande, En confirmation, Confirmée, Préparée,
Expédiée, Livrée, Annulée, Refusée, Retournée (CDC §5.3).

Any other move (for example back from `shipped` to `confirmed`) needs
`orders.override` and a reason.

### 9.3 Effects of each transition (one transaction)

| Transition | Stock | Commissions | Other |
|---|---|---|---|
| order created with attribution | — | create **pending** commissions (influenceuse, and manager if any) | notify |
| → `confirmed` | deduct each line (`sale`); fails the whole transition if any shade lacks stock | — | `confirmed_at` |
| `confirmed`/`prepared`/`shipped` → `cancelled` or `refused` | put back (`sale_reversal`) | pending → **cancelled** | notify |
| `new`/`confirming` → `cancelled` | — (nothing was deducted) | pending → cancelled | |
| → `delivered` | — | pending → **validated**, except commissions `on_hold`, which validate only when a Super Manager releases the hold | `delivered_at`; payment status stays unpaid until cash is recorded |
| `delivered` → `returned` | put back (`return`) | validated → cancelled; if already **paid**, a negative adjustment (clawback) of the same amount | revenue reversed in reports |

Every transition writes `order_status_history`. Every manual edit of an
order's amounts, items or attribution writes `audit_log` (CDC §10).

### 9.4 CRM screens

- **Order list:** filters by status, date range, channel, influenceuse,
  responsable, wilaya, payment status; search by number, name or phone;
  bulk status change for valid transitions.
- **Order page:** everything in CDC §5.2, status timeline, payments, internal
  notes, audit trail.
- **Client page:** contact details, all orders, total spent (delivered, not
  returned), number of orders, last order, acquisition channel, notes (CDC §5.4).

## 10. Commissions and payouts (CDC §4, §9)

- Amounts come from settings (default 300 DA influenceuse, 200 DA
  sous-manager) and are copied onto each commission when it is created, so
  later rule changes do not rewrite history. A per-influenceuse override is
  possible.
- Statuses: **en attente** (pending), **validée**, **payée**, **annulée**.
- A **payout** groups validated commissions and adjustments for one
  beneficiary and period. Marking it paid requires date, amount, method and
  transaction reference; only then do its commissions become **payée**
  (validated ≠ paid, CDC §9).
- Influenceuses and the sous-manager see each commission with its order and
  status, and their payout history.
- Full commission history and every change are kept (CDC §4.3).

## 11. Payments (CDC §9)

| Payment | Where |
|---|---|
| Client payments | `order_payments`; cash on delivery recorded when the carrier remits it (single or bulk entry by order number) |
| Commission payouts | `payouts` (§10) |
| Supplier payments | Expenses with a supplier, category, and paid / unpaid status |
| Paid and unpaid expenses | Expense list filter and dashboard figures |

## 12. Finance (CDC §7)

### 12.1 Definitions

All figures for a chosen period, by Algiers date of delivery unless noted.

| Figure | Definition |
|---|---|
| Gross revenue (CA brut) | Sum of item lines of orders delivered in the period |
| Cancelled and returned | Item lines of orders returned in the period, plus orders cancelled or refused after confirmation (shown separately, for information) |
| Net revenue (CA net) | Gross revenue − returned in the period |
| Booked revenue | Item lines of orders confirmed but not yet delivered (pipeline, not counted as revenue) |
| Delivery fees collected | Shown separately; **not** DARLING* revenue (CDC §7.4) |
| Cost of goods sold | Σ quantity × `unit_purchase_cost` snapshot, for net revenue lines |
| Packaging | Σ quantity × `unit_packaging_cost` snapshot |
| Commissions | Validated and paid commissions on those orders, plus adjustments |
| Delivery borne by DARLING* | Σ `delivery_cost_borne` |
| Advertising | Expenses in category "Publicité et marketing" |
| Other charges | All other expenses **except** merchandise purchases (category flagged `is_merchandise`), which are already counted through cost of goods sold |
| Estimated net result | Net revenue − COGS − packaging − commissions − delivery borne − advertising − other charges |

Revenue by channel distinguishes website, affiliate, Instagram, WhatsApp and
other channels (CDC §7.3). Margin by product and by channel apply the same
formulas to the matching lines.

### 12.2 Forecast margin per product

Shown on each product: selling price − purchase cost − packaging −
commissions (when sold through an influenceuse). With the CDC §7.1 example
(3 300 / 1 500 / 200 / 300 / 200) that is 1 100 DA per affiliated sale and
1 600 DA otherwise. See §19 about 3 300 versus 3 000 DA.

### 12.3 Expenses

All fields of CDC §7.2, the ten categories as seeds (editable), optional
receipt upload (private), paid or unpaid, and **recurring expenses** created
automatically by a daily job on their due date.

## 13. Super Manager dashboard (CDC §8)

KPI tiles, all filterable by period (today, 7 days, this month, custom):
revenue of the day and month, total orders, validated sales, pending orders,
cancelled orders, clients, products sold, total expenses, commissions to pay,
commissions paid, estimated profit, commercial margin.

Charts: sales by day / week / month; sales by channel; influenceuse comparison
and ranking; expenses over time; profitability by product and by channel;
profit over time.

The sous-manager has a team dashboard (clicks, orders, validated sales,
conversion rate, commissions per influenceuse). The influenceuse has her own
(clicks, orders, conversion, commissions by status, last payouts).

## 14. Reports, exports and notifications

### 14.1 Reports (CDC §12)

Sales, orders, clients, influenceuses, commissions, expenses, stock and
profitability; each filterable by period, product, channel and influenceuse;
exported to **CSV, Excel and PDF**. Large exports run as background jobs and
are downloaded from a link valid 24 hours. Every export is written to the
audit log (who exported what), because exports carry personal data.

### 14.2 Notifications (CDC §11)

In-app bell with unread count. Delivery by email and WhatsApp is a later
channel behind the same interface.

| Event | Recipients |
|---|---|
| New order | Super Managers with `orders.read` |
| New affiliated sale | The influenceuse, her sous-manager, Super Managers |
| Order validated (delivered) / cancelled | Same as above for attributed orders |
| Commission generated / validated / paid | Beneficiary |
| Low stock | Super Managers with `stock.write` |
| New influenceuse | Super Managers with `users.manage` |
| Expense recorded | Super Managers with `finance.read` |

## 15. Visual identity

`packages/ui` carries the storefront's tokens (pink `#ed007d`, paper
`#fff6fa`, ink `#24141c`, line colour, glass gradients), DM Sans and Space
Grotesk, the icon set, and portal components built in the same style:
sidebar layout, tables, filters, forms, stat tiles, charts, dialogs, toasts.
Portals are responsive from 375 px (CDC §14), with tables collapsing into
cards on phones. Charts follow one palette derived from the brand pink.

## 16. Quality, security and operations

### 16.1 Tests (definition of done for every sub-project)

- Unit tests for pure rules (pricing, attribution, commission and stock effects, finance formulas).
- API integration tests against a real Postgres for every route.
- **Authorization matrix test:** every route × every role (and a Super Manager
  without the permission), asserting allowed, 404 or 403. A route with no
  declared permission fails this test.
- Playwright end-to-end tests for the key journeys: storefront order with a
  `?ref=` link through delivery and payout; manual WhatsApp order; adding a
  product with shades and media and seeing it on the storefront.
- `pnpm lint`, typecheck, tests and build pass in CI.

### 16.2 Security checklist

- Input validated with Zod at every route; SQL only through parameterised queries.
- Security headers (CSP, HSTS, frame-ancestors none, referrer policy).
- Secrets only in environment variables; `.env` never committed.
- Payout details and TOTP secrets encrypted in the application (AES-256-GCM, key from environment).
- The application's database user has no DDL rights; migrations run with a separate user.
- Dependency audit in CI.
- Rate limits on login, password reset, order intake and click recording.

### 16.3 Backups and restore (CDC §14, §16)

- Nightly encrypted `pg_dump` to separate storage: 30 daily and 12 monthly copies.
- Object storage versioning on for media and receipts.
- A written restore procedure, rehearsed on staging before go-live and then monthly.

### 16.4 Environments

Development (docker compose), staging and production, deployed as Docker
images. The hosting provider is an open decision (§19).

## 17. Delivery roadmap

Each sub-project gets its own detailed implementation plan, written and
reviewed before it starts, and ends with working, tested software.

| # | Sub-project | Delivers | CDC phase |
|---|---|---|---|
| 1 | **Foundation** | Monorepo move, Node 22, docker compose, CI; database and migrations; auth (invite, login, 2FA, reset, sessions); users, roles, permissions; audit and login logs; settings; portal shells for the three roles in the Darling style | 1 |
| 2 | **Catalogue and stock** | Products, shades, categories, media uploads, page content editor with preview, stock movements and alerts, wilaya fees in settings; storefront reading from the database with `/produits` and `/p/[slug]` | 1 |
| 3 | **Orders and CRM** | Storefront order intake into the database, manual orders, status machine with stock effects, clients and deduplication, order and client screens, order numbers | 1 |
| 4 | **Affiliation and commissions** | Links, click tracking, attribution, influenceuse and sous-manager portals, announcements, commissions lifecycle, payouts | 1 |
| 5 | **Finance** | Costs, client payments, expenses (recurring, receipts, suppliers), finance figures, margin per product and channel | 2 |
| 6 | **Dashboards and reports** | Super Manager, team and influenceuse dashboards; all reports with CSV, Excel, PDF exports | 2–3 |
| 7 | **Notifications and integrations** | In-app notifications for every event, email channel; study and, where APIs allow, integrate delivery carriers, WhatsApp and Instagram | 3 |
| 8 | **Go-live** | Security review, load check, backup and restore drill, technical documentation, French user guide per role, production deployment, data import of past orders if wanted | — |

Dependencies: 1 → 2 → 3 → 4; 5 needs 3 and 4; 6 needs 5; 7 needs 3 and 4;
8 is last. Between sub-projects 2 and 3 the storefront keeps the clone's
order stub, now priced from the database; real order storage arrives in 3.
After 4, the platform covers CDC phase 1 and can be used in production
before 5–7 are built.

## 18. Traceability to the cahier des charges

| CDC section | Covered in |
|---|---|
| §1 Overview | §1 |
| §2.1 Influenceuse space | §4.3, §8, §10, §13; announcements §6.2 |
| §2.2 Sous-manager space | §4.3, §8.1, §10, §13 |
| §2.3 Super Managers | §4.1–4.2 and every module |
| §3 Affiliation | §8 |
| §4 Commissions | §6.5, §9.3, §10 |
| §5 CRM | §6.4, §9 |
| §6 Products and stock | §6.3, §7, §9.3 |
| §7 Finance | §6.6, §12 |
| §8 Dashboard | §13 |
| §9 Payments | §10, §11 |
| §10 Access and security | §4, §5, §6.1, §16.2 |
| §11 Notifications | §14.2 |
| §12 Reports | §14.1 |
| §13 Integrations | §17 (sub-project 7); manual entry §9.1 |
| §14 Technical requirements | §3, §15, §16 |
| §15 Phases | §17 |
| §16 Deliverables | §16, §17 (sub-project 8) |
| §17 Expected result | §12, §13 |

## 19. Open decisions (defaults used until answered)

| # | Question | Default in this design |
|---|---|---|
| 1 | Selling price: the site says 3 000 DA, CDC §7.1 says 3 300 DA | Price is per product in the admin; seeded at the site's 3 000 DA |
| 2 | Is a commission per order or per unit (an order of 3 glosses)? | Per order (`commission.basis = per_order`), switchable in settings |
| 3 | Does the sous-manager earn on every influenceuse, or only those assigned to them? | Only those assigned (`manager_id`); today all are assigned to the one sous-manager |
| 4 | Payout methods to support | Cash, CCP, BaridiMob, bank transfer |
| 5 | Consent notice for the attribution cookie | A short information notice on first visit; to be checked against Algerian personal data law (Loi 18-07) with an adviser |
| 6 | Hosting provider and region | Any host running Docker plus managed Postgres and S3-compatible storage |
| 7 | Email provider for invites and resets | Any SMTP provider |
| 8 | Delivery carriers to integrate | None until sub-project 7; candidates to be listed by the owner |
| 9 | Arabic interface | French only in v1; text kept in translation files so Arabic can be added |
| 10 | Import past orders (from Web3Forms emails) | Not imported unless requested in sub-project 8 |

## 20. Out of scope

Online card payment, a customer account area on the storefront, coupon and
discount codes, multi-currency, multi-warehouse stock, accounting exports to
a tax system, and a native mobile app. Each can be added later on this
architecture.

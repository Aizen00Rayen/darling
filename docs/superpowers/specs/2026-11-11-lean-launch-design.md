# DARLING* lean launch — design (Hostinger shared Node.js + SQLite)

Date: 2026-11-11 · Status: approved by the owner ("Approve, start building")
Supersedes the Postgres/Fastify architecture of `2026-11-10-darling-platform-master-design.md` for the FIRST LAUNCH only.
The Postgres version stays on branch `feat/foundation` (reference; its final review findings are folded in below).

## 1. Goal

Launch quickly on a Hostinger shared (Business) Node.js plan: the storefront, saved orders, an admin who manages them,
and influenceuse links with commissions. Everything else (products with media, stock, finance, dashboards, reports,
notifications, integrations) comes after launch.

## 2. Hosting constraints (researched, see Sources in the chat)

- Hostinger shared/cloud: **MySQL only**; no PostgreSQL/Redis/Docker. Node.js 18/20/22/24, deploy from GitHub, up to 5 Node apps
  (Business), ~120 shared processes, 120 s request limit, idle apps are stopped, background work via cron.
- Deploys run `npm install` + `npm run build` + `npm start` ⇒ **plain npm, no pnpm workspaces** (`workspace:*` breaks npm).
- SQLite persistence across redeploys is NOT documented ⇒ the DB file lives OUTSIDE the app directory (`DATA_DIR`), verified with
  `deploy-check/` before relying on it.

## 3. Architecture

- **One Next.js 16 app at the repository root** (storefront + auth pages + portals + all server logic). No separate API service.
  Server code in `src/server/**` (never imported by client components); route handlers in `src/app/api/**`.
- **Database: SQLite file** through a thin adapter `src/server/db/sqlite.ts`:
  `node:sqlite` (built into Node ≥ 22.5, no native build) first; `better-sqlite3` as fallback if `node:sqlite` is unavailable.
  WAL mode, `foreign_keys=ON`, `busy_timeout=5000`. Plain SQL migrations in `migrations/NNNN_name.sql` applied at startup by
  `src/server/db/migrate.ts` (tracked in a `_migrations` table, idempotent, each in a transaction). No ORM.
- **Concurrency model:** one Node process; every state-changing operation runs in `BEGIN IMMEDIATE` (serialised writers) — replaces
  Postgres row/advisory locks. Time comes from an injectable clock. IDs are UUIDv7-like (time-ordered) strings generated in code.
- **Passwords:** Node built-in `crypto.scrypt` (N=16384, r=8, p=1, 16-byte salt, 64-byte key, constant-time compare), format
  `scrypt$N$r$p$salt$hash`. No native hashing module. Same policy as before (≥ 10 chars, common-password list, ≤ 200 chars).
- **Sessions / tokens:** random 256-bit tokens stored as sha256; cookie `__Host-dl_session` (Secure) or `dl_session` in dev; HttpOnly,
  SameSite=Lax, Path=/. Idle 12 h; absolute 24 h, or 30 days with "remember". TOTP 2FA (otpauth, pure JS) required for Super Managers
  while setting `security.require_2fa_super_managers` is true. Secrets (TOTP) encrypted AES-256-GCM with `ENCRYPTION_KEY`.
- **CSRF:** every non-GET API request needs `X-Requested-With: fetch` and `Origin` equal to `APP_ORIGIN`.
- **Access control:** every route handler is wrapped by `withAccess(rule, handler)`; rules: `public | authenticated | role | permission | owner`.
  Enforcement happens BEFORE body parsing/validation. A test scans `src/app/api/**/route.ts` and fails if a route lacks the wrapper or
  an entry in the authorization matrix test (all roles × all routes, exact 401/403).
- **Mail:** SMTP (Hostinger mailbox) via nodemailer for invites and resets; dev uses Mailpit (compose file kept only for Mailpit).
- **Client IP behind Hostinger's proxy (lesson from the Postgres review):** rate limits and logs need the real client address.
  `clientIp(request)` reads `X-Forwarded-For` ONLY according to `TRUSTED_PROXY_HOPS` (number of trusted proxies in front of the app; default 1;
  0 = ignore the header and use the socket address): take the entry `hops` from the right; never the left-most; reject non-IP text.
  Documented, tested (spoofed left-most values ignored).
- **Logging (lesson):** a small logger that never serialises request bodies, cookies, tokens, hashes or SQL parameters; errors are logged as
  `name + message-with-secrets-redacted + stack`; DB errors never include bound parameters.
- **Config guard rails (lesson):** `loadConfig()` refuses `NODE_ENV=production` with a non-`https` `APP_ORIGIN` or `COOKIE_SECURE=false`; keys
  must be 32-byte base64; the DB path must exist/be writable. Unused keys are not required (no `TOKEN_PEPPER`; token hashes use HMAC-SHA256 with
  `ENCRYPTION_KEY`-derived key or plain sha256 — decided: plain sha256 of a 256-bit random token is sufficient; docs must say so).

## 4. Roles and permissions (unchanged)

Roles `super_manager | sub_manager | affiliate`; Super Managers get permissions individually; owners hold all.
Launch permissions: `users.manage`, `orders.read`, `orders.write`, `commissions.manage`, `payouts.manage`, `audit.read`, `settings.manage`
(catalogue/stock/finance/reports permissions stay in the shared list but have no screens yet). Rules carried over from the reviewed design:
owner-only management of Super Managers and the owner flag; nobody changes their own role/permissions; last active owner can never be
removed or suspended; every change to role/permissions/owner/status revokes the target's sessions; actor authority is re-checked inside the
transaction; owners viewing/editing themselves must not send or reset permissions (bug found in review: the form sent an owner's *effective*
permissions as grants).

## 5. Launch features

1. **Accounts & security:** invite-only accounts, login with lockout (10 consecutive failures → 15 min; attempts reserved atomically), per-IP
   throttling (5 logins/min/IP), password reset/invite single-use links, 2FA, audit log (append-only via triggers) and login log.
2. **Orders:** the storefront form posts to `POST /api/orders` (public, rate-limited, honeypot, idempotency key) which validates and re-prices on
   the server and stores the order (customer name, phone, wilaya, commune, address, delivery mode, shade, quantity, unit price, delivery fee,
   total, status, source, affiliate attribution). Order numbers `DL-YY-NNNNNN`. Statuses: `new → confirmed → shipped → delivered`,
   `new|confirmed|shipped → cancelled`, `shipped → refused`, `delivered → returned`; every change recorded in `order_status_history`.
   Admin pages: list with filters (status/date/search), order detail, status change, internal notes, manual order entry (Instagram/WhatsApp).
3. **Affiliation:** each influenceuse has a code (`AYA001`) and link `/?ref=CODE`; a click sets a signed `dl_ref` cookie (30 days, last click
   wins) and records the click (bots excluded, repeat clicks within 30 min counted once); an order inherits the affiliate (and her manager).
   Self-referral (customer phone = affiliate phone) creates the commissions `on_hold`.
4. **Commissions:** 300 DA per delivered order for the influenceuse, 200 DA for her sous-manager (settings, copied onto each commission);
   `pending → validated` when the order becomes `delivered`; `→ cancelled` on cancel/refuse/return (a PAID commission gets a negative
   adjustment instead); `validated → paid` only through an admin "payout" with date, method and reference. Admin page lists commissions per person.
5. **Influenceuse portal (read-only):** her link, clicks, attributed orders (customer shown as first name + initial only, no phone/address),
   commission list by status, totals. Sous-manager portal: the same for his team.
6. **Admin portal:** dashboard (orders by status, today's orders, commissions to pay), orders, users, affiliates & commissions, journal, settings.

## 6. Operations (launch)

- `DATA_DIR` env (outside the app dir), nightly cron `node scripts/backup.mjs` (`VACUUM INTO` a dated file, keep 14), documented Hostinger
  deployment (GitHub import, build/start commands, env variables, cron), first-owner CLI `npm run create-owner`.
- `/api/health` (public) reports DB status. Single process; in-memory rate limits are acceptable (documented).

## 7. Out of scope for launch

Products/media admin, stock, finance, dashboards beyond the simple one, reports/exports, notifications, WhatsApp/Instagram/delivery
integrations, Arabic UI, enforced CSP (report-only header kept), card payments, multi-instance deployment.

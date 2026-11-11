# DARLING*

Storefront for Wet Kiss lip gloss (cash on delivery, Algeria) plus the back office around it: accounts,
admin / manager / influenceuse portals, orders and commissions. One Next.js 16 app, SQLite for data.
Launch design: [`docs/superpowers/specs/2026-11-11-lean-launch-design.md`](docs/superpowers/specs/2026-11-11-lean-launch-design.md),
milestones: [`docs/superpowers/plans/2026-11-11-lean-launch.md`](docs/superpowers/plans/2026-11-11-lean-launch.md).

Status: storefront, accounts (login, 2FA, invites, resets), user management, the audit and login journals and the
settings screen work end to end. Orders and commissions arrive in the next milestones.

## Run it

Needs Node 22 or newer.

```bash
npm ci
cp .env.example .env        # set ENCRYPTION_KEY: openssl rand -base64 32
npm run dev                 # http://localhost:3000
```

| Command | What |
| --- | --- |
| `npm test` | Vitest: storefront, shared rules, UI kit, server (SQLite, migrations, config, logger, IP) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `next typegen` + `tsc --noEmit` |
| `npm run build` / `npm start` | Production build / server (honours `PORT`) |

Dev mail: with `SMTP_URL` empty the invite/reset links are written to the server log (non-production only); or `docker compose -p darling -f infra/docker-compose.yml up -d` starts Mailpit (SMTP 1025, inbox http://localhost:8025).

## First owner

Pick one (both end with an owner who logs in and is sent to enrol 2FA; neither prints or logs a password):

- **Terminal:** `npm run create-owner -- --email you@example.com --name "Your Name"` creates an INVITED owner and prints
  the invitation link (also mailed when SMTP works). It refuses when an owner exists (`--force` overrides) or the email is taken.
- **No terminal (Hostinger):** set `SETUP_TOKEN` (32+ characters: `openssl rand -hex 32`) in the environment, open
  `/configuration`, enter the token, your name, email and a password. The page and `POST /api/setup` exist ONLY while the
  `users` table is empty and `SETUP_TOKEN` is set (anything else: 404 / redirect to `/connexion`); 5 attempts per 15 minutes per
  address. Remove `SETUP_TOKEN` afterwards: once a user exists it does nothing, but a secret you do not need should not stay.

## Layout

| Path | What |
| --- | --- |
| `app/`, `components/`, `lib/`, `data/`, `public/` | Storefront, auth pages and portals (`/admin`, `/manager`, `/affiliate`, `/compte`) |
| `shared/` | Roles, permissions, DTO schemas, password and phone rules (imported as `@/shared`) |
| `ui/` | Portal UI kit and styles (`@/ui`) |
| `server/` | Server-only code: `db/` (SQLite adapter, migrations runner), `auth/`, `security/` (access rules, rate limits), `admin/` (users, journals, settings, first owner), `mail/`, `config.ts`, `log.ts`, `clock.ts`, `ids.ts`, `net/client-ip.ts` |
| `scripts/` | Command-line tools (`create-owner.ts`, run with `tsx`) |
| `migrations/` | Plain SQL migrations (`NNNN_name.sql`), applied on first database use |
| `deploy-check/` | Tiny separate app to verify SQLite persistence on Hostinger |
| `infra/` | `docker-compose.yml` (Mailpit only) |
| `reference/` | Snapshot of the live site used for the storefront port |
| `docs/` | Specs, plans, [`foundation.md`](docs/foundation.md) (superseded Postgres architecture) |

Storefront content lives in `data/products.ts`; the 58 wilayas and delivery rates in `data/delivery.ts`; totals and
validation in `lib/pricing.ts` and `lib/order-schema.ts`. `app/api/orders/route.ts` is still an intake stub (stores nothing).

## Database

SQLite file `<DATA_DIR>/darling.sqlite` (default `./.data` in development, git-ignored; production must point `DATA_DIR`
outside the app directory). `node:sqlite` is used when available, `better-sqlite3` otherwise. Node prints no warning for
it because the adapter filters the one ExperimentalWarning. Timestamps are epoch milliseconds, JSON is stored as text.

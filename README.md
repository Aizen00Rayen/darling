# DARLING*

Storefront for Wet Kiss lip gloss (cash on delivery, Algeria) plus the back office around it: accounts,
admin / manager / influenceuse portals, orders and commissions. One Next.js 16 app, SQLite for data.
Launch design: [`docs/superpowers/specs/2026-11-11-lean-launch-design.md`](docs/superpowers/specs/2026-11-11-lean-launch-design.md),
milestones: [`docs/superpowers/plans/2026-11-11-lean-launch.md`](docs/superpowers/plans/2026-11-11-lean-launch.md).

Status: storefront and portal screens are in place; the server (SQLite adapter, migrations, config, logger,
client IP) is the foundation for the API routes that arrive in the next milestones, so the portal API calls
return 404 for now.

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

Dev mail: `docker compose -p darling -f infra/docker-compose.yml up -d` starts Mailpit (SMTP 1025, inbox http://localhost:8025).

## Layout

| Path | What |
| --- | --- |
| `app/`, `components/`, `lib/`, `data/`, `public/` | Storefront, auth pages and portals (`/admin`, `/manager`, `/affiliate`, `/compte`) |
| `shared/` | Roles, permissions, DTO schemas, password and phone rules (imported as `@/shared`) |
| `ui/` | Portal UI kit and styles (`@/ui`) |
| `server/` | Server-only code: `db/` (SQLite adapter, migrations runner), `config.ts`, `log.ts`, `clock.ts`, `ids.ts`, `net/client-ip.ts`, `test/db.ts` |
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

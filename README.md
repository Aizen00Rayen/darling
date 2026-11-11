# DARLING*

Storefront for Wet Kiss lip gloss (cash on delivery, Algeria) plus the back office around it: accounts,
admin / manager / influenceuse portals, orders and commissions. One Next.js 16 app, SQLite for data.
Launch design: [`docs/superpowers/specs/2026-11-11-lean-launch-design.md`](docs/superpowers/specs/2026-11-11-lean-launch-design.md),
milestones: [`docs/superpowers/plans/2026-11-11-lean-launch.md`](docs/superpowers/plans/2026-11-11-lean-launch.md).

Status: storefront and saved orders, accounts (login, 2FA, invites, resets), user management, influenceuse links with
commissions and payouts, the admin / sous-manager / influenceuse portals, backups and owner diagnostics work end to end.
Everything needed to put it on Hostinger is in [`docs/deploy-hostinger.md`](docs/deploy-hostinger.md).

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
| `npm run test:e2e` | Playwright scenarios in Chromium against a production build on port 3100 (throwaway data, see below) |
| `npm run preflight` | Checklist of the production settings (never prints a secret; `-- --json` for machines; exit 1 on failure) |

Dev mail: with `SMTP_URL` empty the invite/reset links are written to the server log (non-production only); or `docker compose -p darling -f infra/docker-compose.yml up -d` starts Mailpit (SMTP 1025, inbox http://localhost:8025).

## First owner

Pick one (both end with an owner who logs in and is sent to enrol 2FA; neither prints or logs a password):

- **Terminal:** `npm run create-owner -- --email you@example.com --name "Your Name"` creates an INVITED owner and prints
  the invitation link (also mailed when SMTP works). It refuses when an owner exists (`--force` overrides) or the email is taken.
- **No terminal (Hostinger):** set `SETUP_TOKEN` (32+ characters: `openssl rand -hex 32`) in the environment, open
  `/configuration`, enter the token, your name, email and a password. The page and `POST /api/setup` exist ONLY while the
  `users` table is empty and `SETUP_TOKEN` is set (anything else: 404 / redirect to `/connexion`); 5 attempts per 15 minutes per
  address. Remove `SETUP_TOKEN` afterwards: once a user exists it does nothing, but a secret you do not need should not stay.

Lost or expired invitation (owner still `invited`): re-run the same command with the same email: it re-issues the
invitation (older links stop working) and prints the new link. If the `users` table is still empty, the `/configuration`
page works too. An email that belongs to anyone else, or to an active owner, is refused.

## Local demo

Explore the admin dashboard and the influenceuse process with realistic data (about 33 orders over 14 days, clicks,
commissions in every state, payouts, one clawback). Demo data only: never point it at real data.

```bash
npm ci
npm run demo          # seeds ./.data-demo on first run, prints the logins, starts the dev server
# then open http://localhost:3000/connexion
```

All accounts share the demo password `Demo-Darling-2026!` (no 2FA; no mail is sent, links go to the log):

| Account | Email | What you see |
|---|---|---|
| Super Manager (owner) | `owner@demo.darling.test` | everything |
| Super Manager (restricted) | `ops@demo.darling.test` | orders only (`orders.read`, `orders.write`) |
| Sous-manager | `karim@demo.darling.test` | portal of Aya and Lina |
| Influenceuse | `aya@demo.darling.test` | code `AYA001` (manager Karim) |
| Influenceuse | `lina@demo.darling.test` | code `LIN001` (manager Karim) |
| Influenceuse | `sara@demo.darling.test` | code `SAR001` (no manager; one self-referral order on hold) |

Referral links: `http://localhost:3000/?ref=AYA001` (same with `LIN001`, `SAR001`): open one, place an order, and watch it
arrive attributed. Start over with `npm run demo:seed -- --reset` (deletes only `./.data-demo/darling.sqlite`). `PORT`
changes the port. The seed refuses `NODE_ENV=production` and any database that already has users.

## Layout

| Path | What |
| --- | --- |
| `app/`, `components/`, `lib/`, `data/`, `public/` | Storefront, auth pages and portals (`/admin`, `/manager`, `/affiliate`, `/compte`) |
| `shared/` | Roles, permissions, DTO schemas, password and phone rules (imported as `@/shared`) |
| `ui/` | Portal UI kit and styles (`@/ui`) |
| `server/` | Server-only code: `db/` (SQLite adapter, migrations runner), `auth/`, `security/` (access rules, rate limits), `admin/` (users, journals, settings, first owner), `mail/`, `config.ts`, `log.ts`, `clock.ts`, `ids.ts`, `net/client-ip.ts` |
| `scripts/` | Command-line tools run with `tsx`: `create-owner.ts`, `preflight.ts`, the demo seed |
| `e2e/` | Playwright scenarios (`launch.spec.ts`) |
| `migrations/` | Plain SQL migrations (`NNNN_name.sql`), applied on first database use |
| `deploy-check/` | Tiny separate app to verify SQLite persistence on Hostinger |
| `infra/` | `docker-compose.yml` (Mailpit only) |
| `reference/` | Snapshot of the live site used for the storefront port |
| `docs/` | Specs, plans, [`deploy-hostinger.md`](docs/deploy-hostinger.md), [`operations.md`](docs/operations.md), [`foundation.md`](docs/foundation.md) (superseded Postgres architecture) |

Storefront content lives in `data/products.ts`; the 58 wilayas and delivery rates in `data/delivery.ts`; totals and
validation in `lib/pricing.ts` and `lib/order-schema.ts`.

## Database

SQLite file `<DATA_DIR>/darling.sqlite` (default `./.data` in development, git-ignored; production must point `DATA_DIR`
outside the app directory). `node:sqlite` is used when available, `better-sqlite3` otherwise. Node prints no warning for
it because the adapter filters the one ExperimentalWarning. Timestamps are epoch milliseconds, JSON is stored as text.

## Deploy

Hostinger (Business or Cloud, Node.js 22): **[`docs/deploy-hostinger.md`](docs/deploy-hostinger.md)** is the step-by-step guide
for a non-developer: verify with `deploy-check/` that the SQLite file survives a redeploy, create the data folder outside the app,
set the environment variables, create the owner on `/configuration`, enrol 2FA, check the visitor IP on **Diagnostic**, schedule
the backup cron job, go live, update and restore. The daily/weekly routine is in [`docs/operations.md`](docs/operations.md).

Environment variables for production (details and where to get each value in the guide):

| Variable | Notes |
| --- | --- |
| `NODE_ENV=production`, `APP_ORIGIN` (https), `COOKIE_SECURE=true` | the app refuses to start otherwise |
| `DATA_DIR` | folder OUTSIDE the app directory holding `darling.sqlite` and `backups/` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` (32 bytes, base64) |
| `TRUSTED_PROXY_HOPS` | `1` on Hostinger (confirm on `/admin/diagnostics`) |
| `SETUP_TOKEN` | 32+ characters, only until the first owner exists, then remove it |
| `CRON_TOKEN` | 32+ characters; enables `POST /api/cron/backup` (bearer token) |
| `SMTP_URL`, `MAIL_FROM` | Hostinger mailbox: `smtps://user%40domain:password@smtp.hostinger.com:465` |
| `BACKUP_KEEP` | optional, default 14 |
| `MAIL_OUTBOX_DIR` | development and tests only; refused in production |

Backups: `POST /api/backups` ("Sauvegarder maintenant" on the Diagnostic page), the cron line
`curl -fsS -X POST -H "Authorization: Bearer $CRON_TOKEN" https://<domain>/api/cron/backup`, and the newest file downloadable
by the owner (it contains personal data). Restore: stop the app, copy the chosen `backups/darling-*.sqlite` over
`DATA_DIR/darling.sqlite`, delete `darling.sqlite-wal` and `darling.sqlite-shm`, start the app.

## End-to-end tests

`npm run test:e2e` builds the app (about 1.5 minutes), starts `next start` on port 3100 with `NODE_ENV=test` (the production
guard rails refuse an http origin, so the server cannot use `production`; the build itself is a production build), a throwaway
`DATA_DIR`, random secrets and a mail outbox directory, and runs `e2e/launch.spec.ts` in Chromium. The scenarios are SERIAL and
build on each other (owner, then invitations, then the order...): run the whole file, never a single test. Set `E2E_SKIP_BUILD=1`
to reuse the existing `.next` build while iterating. The Playwright version (1.64.0) matches the Chromium already cached in
`~/.cache/ms-playwright`; elsewhere run `npx playwright install chromium`.

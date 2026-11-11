# Platform foundation: developer guide

> **Superseded architecture.** This guide describes the first foundation: a pnpm monorepo with a Fastify API on
> PostgreSQL. The first launch uses a single npm Next.js app with SQLite instead, see
> [`superpowers/specs/2026-11-11-lean-launch-design.md`](superpowers/specs/2026-11-11-lean-launch-design.md). The Postgres
> implementation remains on the `feat/foundation` branch for reference; paths and commands below no longer exist on this branch.
> For deploying and running the launch app see [`deploy-hostinger.md`](deploy-hostinger.md) and [`operations.md`](operations.md).

The foundation is everything the later sub-projects build on: the authentication and authorization API,
the user and audit tables, the three portals (admin, manager, affiliate) and the end-to-end tests.
Design: [`docs/superpowers/specs/2026-11-10-darling-platform-master-design.md`](superpowers/specs/2026-11-10-darling-platform-master-design.md).
Plan: [`docs/superpowers/plans/2026-11-10-platform-foundation.md`](superpowers/plans/2026-11-10-platform-foundation.md).

## Prerequisites

- Node 22 (`.nvmrc`; `engines` rejects other majors) and pnpm 9 through Corepack (`corepack enable`).
- Docker or Podman with the compose plugin, for Postgres 17 and Mailpit.
- `openssl` to generate the two secrets.

## Start everything locally

```bash
pnpm install
pnpm infra:up                       # Postgres (localhost:5433) + Mailpit (SMTP 1025, UI http://localhost:8025)
cp .env.example .env                # then put real values in ENCRYPTION_KEY and TOKEN_PEPPER:
openssl rand -base64 32             # run it twice, once per key
pnpm --filter @darling/api db:migrate
pnpm --filter @darling/api create-owner --email you@example.com --name "Your Name"
pnpm dev                            # API on :4000 and web on :3000
```

`create-owner` creates the first Super Manager with the owner flag and no password, mails an invitation and
prints the link `http://localhost:3000/invitation?token=…` (the mail lands in Mailpit). Open it, choose a
password, log in at `/connexion`, and enrol two-factor authentication: Super Managers must do it before
anything else (`/compte/securite?setup=1`). It refuses to run when an owner already exists (`--force` overrides).
From then on, invite everyone else from **Utilisateurs → Nouvel utilisateur**.

`pnpm infra:up` runs `infra/postgres/init.sql` once, on an empty volume: it creates the roles
`darling_owner` (owns the databases, runs migrations) and `darling_app` (runtime role, DML only) and the
databases `darling` and `darling_test_template`. `pnpm infra:down` stops the containers and keeps the data;
`docker compose -p darling -f infra/docker-compose.yml down -v` deletes it.

Instead of `pnpm dev`, the launch configurations in `.claude/launch.json` start the two apps separately.

## Ports

| Port | What |
| --- | --- |
| 3000 | Web app (storefront and portals), `pnpm dev` |
| 4000 | API (Fastify) |
| 5433 | Postgres (container port 5432) |
| 1025 / 8025 | Mailpit SMTP / web UI and HTTP API |
| 3100 / 4100 | Web app / API started by the end-to-end suite (see below) |

## Environment variables

One `.env` at the repository root; `.env.example` lists every key. The API (`apps/api/src/server.ts`, the
CLI and `db:migrate`) loads it with `dotenv`, the web app loads it in `next.config.ts` with `@next/env`
(Next itself only reads `.env*` inside `apps/web`). Variables already set in the environment win over the file.

| Key | Purpose | Read by | Secret |
| --- | --- | --- | --- |
| `NODE_ENV` | `development`, `test` or `production` | API | no |
| `API_PORT` | API listen port | API | no |
| `APP_ORIGIN` | Public origin of the web app: the CSRF check (`Origin` must match), links in mails | API, web | no |
| `API_INTERNAL_URL` | Where the web app proxies `/api/*` to (server side) | web | no |
| `DATABASE_URL` | Runtime connection, role `darling_app` | API, CLI | yes (password) |
| `DATABASE_OWNER_URL` | Owner connection for migrations, role `darling_owner` | `db:migrate`, e2e | yes (password) |
| `TEST_DATABASE_OWNER_URL` | Owner connection to the `postgres` database; the API tests and the e2e suite create and drop databases through it | tests | yes (password) |
| `COOKIE_SECURE` | `true` marks the session cookie `Secure` and enables HSTS; `false` only for plain-http local use | API, web | no |
| `TRUST_PROXY` | Fastify `trustProxy`; see the security notes | API | no |
| `ENCRYPTION_KEY` | 32 bytes, base64: encrypts TOTP secrets at rest | API | yes |
| `TOKEN_PEPPER` | 32 bytes, base64: keyed hash for session, invitation and reset tokens | API | yes |
| `SMTP_URL` | Mail transport, `smtp://` or `smtps://` (Mailpit locally) | API, CLI | yes if it holds credentials |
| `MAIL_FROM` | Sender of every mail | API, CLI | no |

Never commit `.env`; it is git-ignored. Config errors name the offending keys but never echo values.

## How `/api/*` reaches the API

The browser only talks to the web origin. `apps/web/next.config.ts` has an `afterFiles` rewrite that proxies
`/api/:path*` to `API_INTERNAL_URL`; the storefront's own filesystem route `app/api/orders` wins because
filesystem routes are matched before `afterFiles`. The session cookie is therefore first-party. Server
components call the API through `lib/api/server.ts` (forwarding the cookie), client components through
`lib/api/client.ts`. Every mutating request carries `X-Requested-With: fetch` and a matching `Origin`; the API
refuses anything else with `403 csrf`.

## Roles and permissions

Defined once, in `packages/shared/src`: `roles.ts` (`super_manager`, `sub_manager`, `affiliate`, their labels
and home paths), `permissions.ts` (the 14 permissions, their French labels and who holds what) and the Zod
schemas shared by the API and the web app (`dto.ts`, `settings.ts`, `password.ts`, `phone.ts`). Only Super
Managers hold permissions; the owner holds all of them. The web app derives its navigation and guards from the
same package (`apps/web/lib/portal`).

## Adding an API route

1. Create the route in `apps/api/src/modules/<module>/` and declare **`config.access`**:

   ```ts
   typed.get('/api/things', { config: { access: { kind: 'permission', permission: 'orders.read' } }, schema: … }, handler);
   ```

   Kinds: `public`, `authenticated` (optionally `allowDuring2faEnrollment`), `role`, `permission`, `owner`
   (`apps/api/src/plugins/access.ts`). A route without `access` cannot be registered: the server fails at startup.
2. Add it to `apps/api/test/access-matrix.test.ts`: a row in `MATRIX` (what each principal must get), a row in
   `ENROLLMENT` (blocked or allowed for a Super Manager who has not enrolled 2FA) and, for a `permission` route,
   its entry in `PERMISSION_OF`. The completeness test fails when a registered route is missing from the matrix.
3. Mutating routes are CSRF-protected automatically; destructive or security-relevant actions should call
   `recordAudit` (`apps/api/src/modules/audit/service.ts`).

## Audit log

The `audit_log` table records administrative actions (who, what, on which entity, before/after, when, from
which IP). It is **append-only**: a trigger raises on `UPDATE`/`DELETE` and the runtime role has no such
privilege (`apps/api/drizzle/0001_audit_guard.sql`). It is read through `GET /api/audit-log` (permission
`audit.read`; `GET /api/login-events` for sign-in history) and shown in the admin portal at `/admin/journal`.

## Security properties worth knowing

- **Sessions** are random tokens; only a keyed hash (`TOKEN_PEPPER`) is stored. Password change (other sessions), reset, suspension and
  permission changes revoke sessions. The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`.
- **Passwords** are Argon2id hashes (OWASP minimum profile); the policy (length, common-password list) lives in `packages/shared`.
- **Lock-out and throttling**: login is limited to 5 requests per minute per IP, an account is locked for 15 minutes after 10
  failed attempts, and one answer (`invalid_credentials`) covers unknown e-mail, wrong password, lock and
  suspension. Invitation/reset routes and 2FA verification have their own limits.
- **Two-factor** (TOTP, SHA-1, 6 digits, 30 s) is mandatory for Super Managers while the setting
  `security.require_2fa_super_managers` is on (the default). A code cannot be used twice (the last used step is
  stored); secrets are encrypted with `ENCRYPTION_KEY`.
- **CSP** is `Content-Security-Policy-Report-Only` until sub-project 8; other security headers are enforced.
- **`TRUST_PROXY`** is a boolean today. Behind a reverse proxy it must become a hop count or trusted address
  list before production, otherwise the client IP (rate limit, login log) is the proxy's or can be spoofed.
- **SMTP**: use `smtps://` or a TLS-enforcing relay outside the local machine (see follow-ups).
- The web process loads the whole root `.env`, including secrets it does not need (see follow-ups).

## Tests

| Command | What | Needs |
| --- | --- | --- |
| `pnpm test` | Unit and integration tests of every package (Vitest): shared, ui, storefront and portals (jsdom), API | `pnpm infra:up` (the API tests clone `darling_test_template`) |
| `pnpm --filter @darling/api test` | API integration tests only; each test gets its own database cloned from the template | Postgres |
| `pnpm test:e2e` | Playwright browser tests (`apps/web/e2e`) | Postgres and Mailpit up, a Chromium (below) |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | ESLint, `tsc`, production builds | – |

`pnpm test` never runs the end-to-end suite: it needs real servers.

### End-to-end suite

`apps/web/playwright.config.ts` and `apps/web/e2e/`. The suite is self-contained and does not touch the dev
database or servers:

- `globalSetup` drops and recreates the database `darling_e2e` (as `darling_owner`, from
  `TEST_DATABASE_OWNER_URL`), applies the per-database privileges of `init.sql`, runs the migrations, empties
  Mailpit, creates the first owner with the real `create-owner` CLI, and starts the API on port **4100**.
  Its teardown stops the API, drops `darling_e2e` and deletes `e2e/.tmp/` (git-ignored: invitation link, 2FA
  secret, session).
- Playwright's `webServer` builds the web app and serves it with `next start` on port **3100**
  (`APP_ORIGIN=http://localhost:3100`, `API_INTERNAL_URL=http://localhost:4100`). It can run next to `pnpm dev`.
- Tests run serially (one worker): they share the database and the owner. The first test enrols the owner's 2FA
  and saves the state the later tests reuse to create fixtures, so run the file as a whole.
- The API allows 5 logins per minute per IP; `helpers.ts` budgets them and waits for the window when needed, so
  a full run takes about two minutes. Mails are read from the Mailpit HTTP API, TOTP codes are computed from the
  secret shown on the setup screen.
- Child processes run on Node 22: when the shell's Node is older, `e2e/env.ts` prepends the fnm-installed
  Node 22 if it exists.

Install the browser once with `pnpm --filter @darling/web exec playwright install chromium` (CI uses
`--with-deps`). The pinned `@playwright/test` expects Chromium build 1248; if you already have a cached
Chromium elsewhere, point `PLAYWRIGHT_BROWSERS_PATH` at it. CI runs the suite in the `e2e` job of
`.github/workflows/ci.yml` (Postgres and Mailpit service containers, random secrets generated per run).

## Known follow-ups

- Make `TRUST_PROXY` a hop count or trusted-address list before go-live.
- Narrow the web process environment to `APP_ORIGIN`, `API_INTERNAL_URL` and `COOKIE_SECURE`.
- SMTP: require TLS for non-loopback hosts (`requireTLS`) and set transport timeouts.
- Per-account throttling on password reset (today only per IP).
- Drizzle error messages embed query parameters: the error serializer must strip them before logging.
- Enforce the CSP (after nonce support is checked against the storefront) and add a report endpoint.
- The storefront `OrderForm` should be a real `<form method="post">` so it works before hydration.
- Subscribers of the audit log must never expose it to users without `audit.read`.

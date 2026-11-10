# Lean launch implementation plan (milestones)

Spec: `docs/superpowers/specs/2026-11-11-lean-launch-design.md` (binding). Branch: `feat/launch` (from `main`).
Reference implementation of the same behaviour on Postgres: branch `feat/foundation` (`git show feat/foundation:<path>`) — port its
logic, tests and UI; do NOT port its infrastructure. The earlier final review's findings are folded into the spec (§3, §4).

Execution: one implementer per milestone, one independent review per milestone (security milestones on the most capable reviewer),
fixes in one round per milestone. Each milestone ends green: `npm run lint && npm run typecheck && npm test && npm run build`, committed.

| # | Milestone | Delivers |
|---|---|---|
| M1 | Flatten + database | Single npm Next.js app at repo root (storefront moved up, `packages/shared` + `packages/ui` become `src/shared`, `src/ui`), `apps/api`, pnpm workspace, Postgres infra and old e2e removed; SQLite adapter, migrations, schema for users/sessions/tokens/audit/login events/settings, test harness (in-memory DB, fake clock), config + logger + clientIp |
| M2 | Auth core | scrypt, sessions, login/lockout/throttle, logout, me, 2FA enrol/enable/disable, password change, invite + reset flows, CSRF/origin, `withAccess`, mail, authorization-matrix test, auth pages wired to the new route handlers |
| M3 | Admin basics | Users management (owner rules, last-owner, session revocation, re-authorisation in tx), audit + login log APIs, settings, first-owner CLI, portal shells + users/journal/settings/security screens (fix owner-edit bug), `/api/health` |
| M4 | Orders | Tables + status machine + `POST /api/orders` (storefront order form wired, `method="post"` fix), admin orders list/detail/status/notes/manual entry |
| M5 | Affiliation & commissions | Codes, `?ref=` tracking + cookie + clicks, attribution, commissions lifecycle + payouts, admin affiliates/commissions pages, influenceuse + sous-manager read-only portals |
| M6 | Deploy | Hostinger guide, backup script + cron docs, e2e (Playwright, one server, SQLite temp file), CI, final whole-branch review and fix pass |

Pre-launch check (owner, in parallel with M1–M3): deploy `deploy-check/` to the Hostinger plan, confirm SQLite works and the data file survives a
redeploy (see `deploy-check/README.md`); report the JSON. If `node:sqlite` is not available there, switch the adapter's default to `better-sqlite3`
(the adapter supports both) — no other change.

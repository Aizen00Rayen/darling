# DARLING*

The DARLING* platform: a public storefront (Wet Kiss lip gloss, cash on delivery, Algeria) and the back
office around it. Today it contains the storefront, the authentication/authorization foundation and the
admin, manager and affiliate portals.

## Workspace layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js 16 app: storefront (`/`), authentication pages and the portals (`/admin`, `/manager`, `/affiliate`, `/compte`); Playwright tests in `e2e/` |
| `apps/api` | Fastify + Postgres API: sessions, 2FA, invitations, users, audit log, settings; CLI (`create-owner`) |
| `packages/shared` | Roles, permissions and Zod schemas shared by the API and the web app |
| `packages/ui` | React components and styles of the portals |
| `infra` | `docker-compose.yml` (Postgres 17, Mailpit) and `postgres/init.sql` |
| `docs` | [`foundation.md`](docs/foundation.md) developer guide, design specs and plans |

## Quick start

```bash
pnpm install
pnpm infra:up
cp .env.example .env     # fill ENCRYPTION_KEY and TOKEN_PEPPER with `openssl rand -base64 32`
pnpm --filter @darling/api db:migrate
pnpm --filter @darling/api create-owner --email you@example.com --name "Your Name"
pnpm dev                 # web http://localhost:3000, API http://localhost:4000
```

Requires Node 22 and pnpm 9 (Corepack). Details, environment variables and conventions are in
[`docs/foundation.md`](docs/foundation.md).

## Commands

| Command | What |
| --- | --- |
| `pnpm dev` | Web (3000) and API (4000) in watch mode |
| `pnpm test` | Unit and integration tests of every package (needs `pnpm infra:up`) |
| `pnpm test:e2e` | Playwright end-to-end tests (own database and ports; needs Postgres and Mailpit) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript |
| `pnpm build` | Production builds |
| `pnpm infra:up` / `pnpm infra:down` | Start / stop Postgres and Mailpit |

## Documents

- Developer guide: [`docs/foundation.md`](docs/foundation.md)
- Platform design: [`docs/superpowers/specs/2026-11-10-darling-platform-master-design.md`](docs/superpowers/specs/2026-11-10-darling-platform-master-design.md)
- Foundation plan: [`docs/superpowers/plans/2026-11-10-platform-foundation.md`](docs/superpowers/plans/2026-11-10-platform-foundation.md)
- Storefront: [`apps/web/README.md`](apps/web/README.md)

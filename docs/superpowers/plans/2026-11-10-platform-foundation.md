# Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the storefront repo into the platform monorepo and deliver sub-project 1 of the master design: a Fastify API on PostgreSQL with invite-only accounts, sessions, 2FA, password reset, roles and permissions, audit and login logs, settings, and the three portal shells in the Darling style.

**Architecture:** pnpm workspace with `apps/api` (Fastify + Drizzle on Postgres), `apps/web` (the existing Next.js storefront plus portals), `packages/shared` (Zod schemas, permission catalogue, policies) and `packages/ui` (design tokens and portal components). Next.js rewrites `/api/*` to Fastify so the session cookie is first-party. Every API route declares its access rule; the app refuses to start if one does not.

**Tech Stack:** Node 22 LTS, pnpm 9, TypeScript 5, Fastify 5, fastify-type-provider-zod, Zod 4, Drizzle ORM + drizzle-kit, PostgreSQL 17, argon2, otpauth, nodemailer, Next.js 16, Vitest, Playwright, Docker Compose (Podman engine on the dev machine).

**Spec:** `docs/superpowers/specs/2026-11-10-darling-platform-master-design.md` — this plan covers §3, §4, §5, §6.1, §15, §16.1–16.2 and roadmap row 1 of §17.

**Left to later sub-projects on purpose:** sous-managers creating influenceuses in their team, affiliate codes and the team link (`affiliate_profiles.manager_id`) arrive with sub-project 4; until then only Super Managers with `users.manage` create accounts. Object storage (MinIO) arrives with sub-project 2. Backups and the enforced Content-Security-Policy arrive with sub-project 8.

## Global Constraints

- Work on branch `feat/foundation`, created from `feat/storefront-clone` (main does not contain the storefront yet).
- Node `>=22 <23` in every `package.json` `engines`; pnpm workspace; TypeScript `strict`.
- All interface text in French. All money in whole dinars (`integer`), no floats (no money tables in this plan).
- All timestamps `timestamptz`; day boundaries Africa/Algiers.
- Primary keys UUIDv7 generated in the app (`uuid` package `v7()`); bigserial for log tables.
- Every API route lives under `/api` and declares `config.access`; a missing declaration aborts startup.
- Access to another user's record by ID that the caller may not see returns **404**.
- Passwords: argon2id, minimum 10 characters, rejected if in the common-password list. Never logged.
- Session cookie: name `__Host-dl_session` when `COOKIE_SECURE=true`, otherwise `dl_session`; httpOnly, SameSite=Lax, path `/`. Idle timeout 12 h; absolute 24 h, or 30 days with "remember me".
- Non-GET requests must carry `X-Requested-With: fetch` and an `Origin` equal to `APP_ORIGIN`.
- Login: 5 attempts per minute per IP; lock 15 minutes after 10 consecutive failures; one response (`401 invalid_credentials`) for unknown email, wrong password and locked account.
- Reset token valid 30 minutes; invite token valid 7 days; both single-use and stored as SHA-256 hashes.
- 2FA TOTP (SHA-1, 6 digits, 30 s, ±1 step); required for Super Managers while setting `security.require_2fa_super_managers` is `true` (default).
- `audit_log` is append-only: the app database role has only `SELECT, INSERT` on it and a trigger rejects `UPDATE`/`DELETE`.
- Secrets only from environment; `.env` is git-ignored; `.env.example` is committed.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The storefront must keep passing its 63 tests and its visual parity throughout.

## Review Focus

1. Email typed with different case or surrounding spaces (` Owner@Darling.DZ `): login, invite and user creation treat it as the same address; creating a duplicate returns `409 email_taken`, not 500. (Tasks 7, 10)
2. Two owners removing each other's owner flag at the same time: one request must fail with `409 last_owner`; never zero active owners. (Task 10)
3. A reset or invite link reused, expired, or belonging to a suspended account: rejected with `400 invalid_token` and does not reactivate the account. (Task 9)
4. A user's permissions or role reduced while they are logged in: their next request already uses the new rights, and their other sessions are revoked. (Task 10)
5. A valid TOTP code replayed within its 90-second window: rejected the second time. (Task 8)

---

## File map

```
pnpm-workspace.yaml, package.json (root), .nvmrc, .env.example, .github/workflows/ci.yml
infra/docker-compose.yml, infra/postgres/init.sql
apps/web/                 ← everything the storefront has today (app/, components/, data/, lib/, public/, reference/, configs)
apps/web/proxy.ts                         portal cookie gate
apps/web/lib/api/{server.ts,client.ts}    API helpers
apps/web/lib/auth/session.ts              getMe / requireUser
apps/web/app/(auth)/…                     connexion, mot-de-passe-oublie, reinitialiser, invitation
apps/web/app/(portal)/…                   admin/*, manager/*, affiliate/*, compte/securite
apps/web/e2e/foundation.spec.ts, playwright.config.ts
apps/api/src/config.ts                    env loading
apps/api/src/app.ts, server.ts            app factory, entrypoint
apps/api/src/db/{client.ts,schema.ts,migrate.ts}, apps/api/drizzle/*.sql
apps/api/src/lib/{crypto.ts,totp.ts,clock.ts}
apps/api/src/mail/{mailer.ts,templates.ts}
apps/api/src/plugins/{access.ts,auth.ts,csrf.ts,errors.ts}
apps/api/src/modules/auth/{sessions.ts,routes.ts,login.ts,tokens.ts,two-factor.ts}
apps/api/src/modules/users/{service.ts,routes.ts}
apps/api/src/modules/audit/{service.ts,routes.ts}
apps/api/src/modules/settings/{service.ts,routes.ts}
apps/api/src/cli/create-owner.ts
apps/api/test/{global-setup.ts,context.ts,access-matrix.test.ts}
packages/shared/src/{roles.ts,permissions.ts,settings.ts,phone.ts,password.ts,dto.ts,index.ts}, data/common-passwords.txt
packages/ui/src/{tokens.css,portal.css,AppShell.tsx,Button.tsx,Field.tsx,Table.tsx,Badge.tsx,PageHeader.tsx,Notice.tsx,index.ts}
```

---

### Task 1: Monorepo move and Node 22

**Files:**
- Create: `pnpm-workspace.yaml`, root `package.json`, `.nvmrc` (`22`), `apps/web/package.json` (from current root)
- Move: `app/ components/ data/ lib/ public/ reference/ next.config.ts tsconfig.json eslint.config.mjs vitest.config.mts AGENTS.md README.md .claude/launch.json` → `apps/web/` (keep `docs/` at root)
- Modify: `.gitignore` (add `.env`, `apps/*/.next`, `apps/*/node_modules`)

**Interfaces:**
- Produces: root scripts `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` running each workspace via `pnpm -r --if-present`; web package name `@darling/web`.

- [ ] **Step 1: Prerequisite.** `node -v` must print `v22.x`. If not, stop and ask the owner to install Node 22 LTS (for example with fnm: `fnm install 22 && fnm default 22`). Then `corepack enable`.
- [ ] **Step 2:** `git checkout -b feat/foundation` from `feat/storefront-clone`. `git mv` the listed paths into `apps/web/`. Root `package.json`: `private`, `packageManager: pnpm@9.15.9`, `engines.node: ">=22 <23"`, scripts above. `pnpm-workspace.yaml`: `packages: ['apps/*', 'packages/*']`.
- [ ] **Step 3:** In `apps/web`, upgrade Vitest to the current major (it now runs on Node 22) and keep `vitest.config.mts`. Update `.claude/launch.json` to run `pnpm --filter @darling/web dev`.
- [ ] **Step 4: Verify.** `pnpm install && pnpm test && pnpm lint && pnpm build`. Expected: 63 tests pass, lint clean, build lists `/`, `/merci`, `/api/orders`.
- [ ] **Step 5: Commit** `chore: move storefront into apps/web pnpm workspace on Node 22`.

### Task 2: Local infrastructure and CI

**Files:**
- Create: `infra/docker-compose.yml`, `infra/postgres/init.sql`, `.env.example`, `.github/workflows/ci.yml`, root script `pnpm infra:up` / `infra:down`

**Interfaces:**
- Produces: Postgres 17 on `localhost:5433`, superuser `postgres/postgres`; roles `darling_owner` (LOGIN, CREATEDB, owns schema) and `darling_app` (LOGIN, DML only); databases `darling` and `darling_test_template`. Mailpit SMTP `localhost:1025`, UI `http://localhost:8025`.
- `.env.example` keys (exact):
  ```
  NODE_ENV=development
  API_PORT=4000
  APP_ORIGIN=http://localhost:3000
  API_INTERNAL_URL=http://localhost:4000
  DATABASE_URL=postgres://darling_app:darling_app@localhost:5433/darling
  DATABASE_OWNER_URL=postgres://darling_owner:darling_owner@localhost:5433/darling
  TEST_DATABASE_OWNER_URL=postgres://darling_owner:darling_owner@localhost:5433/postgres
  COOKIE_SECURE=false
  TRUST_PROXY=false
  ENCRYPTION_KEY=          # 32 random bytes, base64: openssl rand -base64 32
  TOKEN_PEPPER=            # 32 random bytes, base64, hashes IP and user agent
  SMTP_URL=smtp://localhost:1025
  MAIL_FROM="DARLING* <no-reply@darling7.store>"
  ```

- [ ] **Step 1:** Write compose (services `postgres:17`, `axllent/mailpit`; named volume; healthcheck `pg_isready`). `init.sql` creates the two roles with the passwords above and both databases owned by `darling_owner`, and runs `ALTER DEFAULT PRIVILEGES FOR ROLE darling_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO darling_app` plus `USAGE, SELECT ON SEQUENCES`.
- [ ] **Step 2: Verify.** `pnpm infra:up`, then `psql postgres://darling_app:darling_app@localhost:5433/darling -c 'select 1'` prints `1`, and `curl -s localhost:8025` returns HTML. (The machine's `docker` talks to Podman; if `docker compose` fails, stop and report.)
- [ ] **Step 3:** CI workflow on push and pull request: Node 22, pnpm, Postgres 17 service with the same init script, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- [ ] **Step 4: Commit** `chore: add local Postgres and Mailpit compose, env example and CI`.

### Task 3: Shared package — roles, permissions, policies, DTOs

**Files:**
- Create: `packages/shared/` (`package.json` name `@darling/shared`, exports TS source), `src/*.ts` per file map, `data/common-passwords.txt`
- Test: `packages/shared/src/*.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // roles.ts
  export const ROLES = ['super_manager', 'sub_manager', 'affiliate'] as const;
  export type Role = (typeof ROLES)[number];
  export const USER_STATUSES = ['invited', 'active', 'suspended', 'deactivated'] as const;
  export type UserStatus = (typeof USER_STATUSES)[number];
  export const ROLE_LABELS: Record<Role, string>;   // 'Super Manager', 'Sous-manager', 'Influenceuse'
  export function homePathFor(role: Role): '/admin' | '/manager' | '/affiliate';
  // permissions.ts — the 14 permissions of spec §4.2, in that order
  export const PERMISSIONS = ['users.manage','orders.read','orders.write','orders.override','clients.merge',
    'catalog.write','stock.write','commissions.manage','payouts.manage','finance.read','expenses.write',
    'reports.export','settings.manage','audit.read'] as const;
  export type Permission = (typeof PERMISSIONS)[number];
  export const PERMISSION_LABELS: Record<Permission, string>;  // French
  export function effectivePermissions(u: { role: Role; isOwner: boolean; granted: Permission[] }): Permission[];
  // settings.ts
  export const SETTINGS: { 'security.require_2fa_super_managers': z.ZodBoolean; 'company.name': z.ZodString };
  export const SETTING_DEFAULTS: { 'security.require_2fa_super_managers': true; 'company.name': 'DARLING*' };
  export type SettingKey = keyof typeof SETTINGS;
  // phone.ts
  export function normalizePhone(input: string): string | null; // '+213 6 12 34 56 78' → '0612345678'; invalid → null
  // password.ts
  export function passwordProblem(pw: string): string | null;    // French message or null
  // dto.ts (Zod schemas + inferred types)
  export const emailSchema;          // trim, lower-case, valid email, ≤ 254
  export const meSchema;             // { id, email, fullName, role, isOwner, permissions, twoFactorEnabled, mustEnroll2fa }
  export const userSchema;           // { id, email, fullName, phone|null, role, status, isOwner, permissions, twoFactorEnabled, lastLoginAt|null, createdAt }
  export const loginInput, createUserInput, updateUserInput, passwordResetInput, inviteAcceptInput, changePasswordInput;
  export const apiErrorSchema;       // { code: string, message?: string, errors?: Record<string,string> }
  ```

- [ ] **Step 1: Write failing tests.**
  ```ts
  expect(effectivePermissions({ role: 'super_manager', isOwner: true, granted: [] })).toEqual([...PERMISSIONS]);
  expect(effectivePermissions({ role: 'super_manager', isOwner: false, granted: ['audit.read'] })).toEqual(['audit.read']);
  expect(effectivePermissions({ role: 'sub_manager', isOwner: false, granted: ['audit.read'] })).toEqual([]);
  expect(homePathFor('affiliate')).toBe('/affiliate');
  expect(normalizePhone('+213 6 12 34 56 78')).toBe('0612345678');
  expect(normalizePhone('0812345678')).toBeNull();
  expect(passwordProblem('court')).toMatch(/10 caractères/);
  expect(passwordProblem('password123')).toMatch(/trop courant/);   // in the list
  expect(passwordProblem('Rose-gloss-2026')).toBeNull();
  expect(emailSchema.parse('  Owner@Darling.DZ ')).toBe('owner@darling.dz');
  expect(SETTINGS['security.require_2fa_super_managers'].safeParse('yes').success).toBe(false);
  ```
- [ ] **Step 2:** Run `pnpm --filter @darling/shared test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement. `common-passwords.txt` = first 1000 lines of SecLists `Passwords/Common-Credentials/10k-most-common.txt`, lower-cased; comparison is case-insensitive. Move the storefront's phone normalisation to `normalizePhone` and make `apps/web/lib/order-schema.ts` import it.
- [ ] **Step 4:** Run shared and web tests. Expected: PASS, web still 63.
- [ ] **Step 5: Commit** `feat(shared): add roles, permissions, settings registry, phone, password policy and DTOs`.

### Task 4: API skeleton

**Files:**
- Create: `apps/api/package.json` (`@darling/api`, scripts `dev` = `tsx watch src/server.ts`, `test`, `typecheck`, `db:generate`, `db:migrate`), `tsconfig.json`, `vitest.config.mts`, `src/config.ts`, `src/lib/clock.ts`, `src/plugins/errors.ts`, `src/app.ts`, `src/server.ts`
- Test: `src/config.test.ts`, `src/app.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Config = { nodeEnv: 'development'|'test'|'production'; port: number; appOrigin: string;
    databaseUrl: string; databaseOwnerUrl: string; cookieSecure: boolean; trustProxy: boolean;
    encryptionKey: Buffer; tokenPepper: Buffer; smtpUrl: string; mailFrom: string };
  export function loadConfig(env: Record<string, string | undefined>): Config;   // throws listing every bad key
  export type Clock = () => Date;
  export type AppDeps = { config: Config; db: Db; mailer: Mailer; clock: Clock };
  export async function buildApp(deps: AppDeps): Promise<FastifyInstance>;
  ```
  Error responses always `{ code, message?, errors? }`: Zod failures → `400 { code: 'validation', errors: { field: message } }`; unknown → `500 { code: 'internal' }` without stack.
- Registers: `@fastify/helmet` (CSP default-src 'none' for API responses), `@fastify/cookie`, `@fastify/rate-limit` (global off, per-route config), request ID header `x-request-id`, pino with `redact` of `req.headers.cookie`, `password`, `newPassword`, `currentPassword`, `token`.

- [ ] **Step 1: Write failing tests.** `loadConfig` throws an error mentioning `ENCRYPTION_KEY` when it is missing or not 32 bytes; parses `COOKIE_SECURE=false` as `false`. `buildApp` + `inject GET /api/health` → `200 { ok: true, db: 'up' }` (db stubbed via a fake `Db` with `execute` resolving) and response has `x-request-id`.
- [ ] **Step 2:** Run `pnpm --filter @darling/api test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `server.ts` loads `.env` from the repo root (`dotenv`), builds real deps, listens on `API_PORT`. Health route declares `access: { kind: 'public' }` (the access plugin arrives in Task 6; until then the config is just carried).
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add Fastify skeleton with config, errors, logging and health`.

### Task 5: Database schema, migrations and test harness

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `drizzle/0000_identity.sql` (generated), `drizzle/0001_audit_guard.sql` (custom), `test/global-setup.ts`, `test/context.ts`
- Test: `src/db/schema.test.ts`

**Interfaces:**
- Produces tables exactly as spec §6.1 with these concrete columns:
  - `users`: `id uuid pk`, `email citext unique not null`, `password_hash text null` (null until invite accepted), `full_name text not null`, `phone text null`, `role text not null check in ROLES`, `status text not null default 'invited' check in USER_STATUSES`, `is_owner boolean not null default false`, `totp_secret_enc text null`, `totp_enabled boolean not null default false`, `totp_last_step bigint null`, `failed_logins int not null default 0`, `locked_until timestamptz null`, `last_login_at timestamptz null`, `created_at`, `updated_at`; check `is_owner implies role = 'super_manager'`.
  - `user_permissions(user_id uuid fk cascade, permission text check in PERMISSIONS, pk(user_id, permission))`
  - `sessions(id uuid pk, token_hash text unique, user_id fk cascade, ip text, user_agent text, remember boolean, created_at, last_seen_at, expires_at, revoked_at null)`
  - `auth_tokens(id uuid pk, user_id fk cascade, type text check in ('invite','password_reset'), token_hash text unique, expires_at, used_at null, created_at)`
  - `login_events(id bigserial pk, user_id null fk set null, email_tried text, ip text, user_agent text, success boolean, reason text, at)`
  - `audit_log(id bigserial pk, actor_user_id uuid null, action text, entity_type text, entity_id text, before jsonb null, after jsonb null, reason text null, ip text null, request_id text null, at)`
  - `settings(key text pk, value jsonb not null, updated_by uuid null, updated_at)`
  - Migration 0000 starts with `CREATE EXTENSION IF NOT EXISTS citext;`. Migration 0001: trigger `audit_log_append_only` raising on UPDATE/DELETE; `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM darling_app`.
  ```ts
  export type Db = NodePgDatabase<typeof schema>;
  export function createDb(url: string): { db: Db; close(): Promise<void> };
  export async function runMigrations(ownerUrl: string): Promise<void>;
  // test/context.ts
  export type TestContext = { app: FastifyInstance; db: Db; mailer: MemoryMailer; clock: TestClock; close(): Promise<void> };
  export async function createTestContext(): Promise<TestContext>;   // fresh DB cloned from darling_test_template
  export async function seedUser(ctx, input: { role: Role; email?: string; password?: string; isOwner?: boolean;
    permissions?: Permission[]; status?: UserStatus; totp?: boolean }): Promise<{ id: string; email: string; password: string; totpSecret?: string }>;
  export async function login(ctx, email: string, password: string, totpCode?: string): Promise<string>; // returns Cookie header
  ```
  `global-setup.ts` drops and recreates `darling_test_template`, migrates it, then marks it a template. Each context runs `CREATE DATABASE darling_test_<uuid> TEMPLATE darling_test_template` as owner, connects as `darling_app`, and drops it on `close()`.

- [ ] **Step 1: Write failing tests** (against a real test DB):
  ```ts
  // inserting two users whose emails differ only by case → unique violation
  // inserting a user with is_owner=true and role 'affiliate' → check violation
  // as darling_app: UPDATE audit_log … → rejects; DELETE FROM audit_log → rejects; INSERT → ok
  ```
- [ ] **Step 2:** Run. Expected: FAIL (no schema).
- [ ] **Step 3:** Write schema, generate 0000 with drizzle-kit, write 0001 by hand, implement client, migrate and harness. `db:migrate` uses `DATABASE_OWNER_URL`.
- [ ] **Step 4:** Run `pnpm --filter @darling/api test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add identity schema, migrations, audit guard and test harness`.

### Task 6: Crypto, mail and the access plugin

**Files:**
- Create: `src/lib/crypto.ts`, `src/lib/totp.ts`, `src/mail/mailer.ts`, `src/mail/templates.ts`, `src/plugins/access.ts`, `src/plugins/csrf.ts`
- Test: `src/lib/crypto.test.ts`, `src/lib/totp.test.ts`, `src/plugins/access.test.ts`, `src/plugins/csrf.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // crypto.ts
  export async function hashPassword(pw: string): Promise<string>;           // argon2id, memoryCost 19456, timeCost 2
  export async function verifyPassword(hash: string, pw: string): Promise<boolean>;
  export const DUMMY_HASH: string;                                           // verified against when the email is unknown
  export function newToken(): { token: string; hash: string };               // 32 random bytes base64url; sha256 hex
  export function hashToken(token: string): string;
  export function encryptSecret(plain: string, key: Buffer): string;         // 'v1:<iv>:<tag>:<ct>' AES-256-GCM, base64url parts
  export function decryptSecret(enc: string, key: Buffer): string;
  export function pepperHash(value: string, pepper: Buffer): string;         // HMAC-SHA256 hex (IP / user agent)
  // totp.ts
  export function newTotpSecret(): string;                                   // base32
  export function totpUri(secret: string, email: string): string;            // issuer 'DARLING*'
  export function verifyTotp(secret: string, code: string, now: Date, lastStep: number | null): number | null; // matched step or null
  // mailer.ts
  export type Mail = { to: string; subject: string; text: string; html: string };
  export type Mailer = { send(mail: Mail): Promise<void> };
  export function smtpMailer(url: string, from: string): Mailer;
  export type MemoryMailer = Mailer & { sent: Mail[] };
  export function memoryMailer(): MemoryMailer;
  // templates.ts (French)
  export function inviteMail(p: { fullName: string; link: string; roleLabel: string }): Omit<Mail, 'to'>;
  export function resetMail(p: { fullName: string; link: string }): Omit<Mail, 'to'>;
  // access.ts
  export type Access =
    | { kind: 'public' }
    | { kind: 'authenticated'; allowDuring2faEnrollment?: boolean }
    | { kind: 'role'; roles: Role[] }
    | { kind: 'permission'; permission: Permission }
    | { kind: 'owner' };
  declare module 'fastify' { interface FastifyContextConfig { access?: Access } }
  export const accessPlugin: FastifyPluginAsync;   // onRoute: throws `Route METHOD URL has no access rule`; preHandler enforces
  ```
  Enforcement: no session → `401 { code: 'unauthenticated' }`; session but `mustEnroll2fa` and route not `allowDuring2faEnrollment` → `403 { code: '2fa_enrollment_required' }`; wrong role or missing permission → `403 { code: 'forbidden' }`. `owner` passes only owners. `permission` passes only Super Managers holding it (owners hold all).
  CSRF plugin: for non-GET/HEAD, require `x-requested-with: fetch` and `origin === config.appOrigin` → else `403 { code: 'csrf' }`.

- [ ] **Step 1: Write failing tests.**
  ```ts
  expect(await verifyPassword(await hashPassword('Rose-gloss-2026'), 'Rose-gloss-2026')).toBe(true);
  expect(decryptSecret(encryptSecret('JBSWY3DP', key), key)).toBe('JBSWY3DP');
  expect(() => decryptSecret(tamperedLastChar, key)).toThrow();
  const { token, hash } = newToken(); expect(hashToken(token)).toBe(hash); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // totp: code for step S accepted at S-1, S, S+1; rejected at S+2; rejected when lastStep === S (replay)
  // access: a route registered without config.access → buildApp rejects with /no access rule/
  // access: test routes for each Access kind × (anonymous, affiliate, sub_manager, super_manager without perm, with perm, owner)
  //   yield exactly 401/403/200 per the rules above
  // csrf: POST without x-requested-with → 403 csrf; with wrong Origin → 403 csrf; GET without either → passes
  ```
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Access plugin reads `request.auth` set by Task 7's auth plugin; until then tests set it through a test-only `decorateRequest` hook.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add crypto, TOTP, mailer and access and CSRF plugins`.

### Task 7: Sessions, login, logout, me

**Files:**
- Create: `src/modules/auth/sessions.ts`, `src/plugins/auth.ts`, `src/modules/auth/login.ts`, `src/modules/auth/routes.ts`, `src/modules/audit/service.ts`, `src/modules/settings/service.ts`
- Test: `src/modules/auth/login.test.ts`, `src/modules/auth/sessions.test.ts`

**Interfaces:**
- Consumes: Task 5 harness, Task 6 crypto/access/csrf.
- Produces:
  ```ts
  // sessions.ts
  export const IDLE_MS = 12 * 3600_000, ABSOLUTE_MS = 24 * 3600_000, REMEMBER_MS = 30 * 24 * 3600_000;
  export async function createSession(db: Db, p: { userId: string; remember: boolean; ip: string; userAgent: string; now: Date }): Promise<{ token: string; expiresAt: Date }>;
  export async function resolveSession(db: Db, token: string, now: Date): Promise<{ sessionId: string; userId: string } | null>; // checks revoked, absolute and idle; bumps last_seen_at at most once a minute
  export async function revokeSession(db: Db, sessionId: string): Promise<void>;
  export async function revokeUserSessions(db: Db, userId: string, exceptSessionId?: string): Promise<void>;
  // auth plugin sets request.auth on every request:
  export type AuthContext = { sessionId: string; userId: string; role: Role; isOwner: boolean;
    permissions: Set<Permission>; mustEnroll2fa: boolean } | null;
  // audit service
  export async function recordAudit(tx: Db, e: { actorUserId: string | null; action: string; entityType: string;
    entityId: string; before?: unknown; after?: unknown; reason?: string; ip?: string; requestId?: string }): Promise<void>;
  // settings service
  export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<z.infer<(typeof SETTINGS)[K]>>; // default when no row
  ```
  The auth plugin loads user, status, role and permissions **on every request** (no caching in the session), and treats users whose status is not `active` as anonymous.
- Routes:
  | Method, path | Access | Body | Responses |
  |---|---|---|---|
  | `POST /api/auth/login` | public, rate limit 5/min/IP | `{ email, password, remember?: boolean, totpCode?: string }` | `200 { user: Me }` + cookie · `401 invalid_credentials` · `401 totp_required` · `401 totp_invalid` · `429 too_many_attempts` |
  | `POST /api/auth/logout` | authenticated (allow enrollment) | — | `204`, cookie cleared |
  | `GET /api/auth/me` | authenticated (allow enrollment) | — | `200 Me` |
  `mustEnroll2fa = role === 'super_manager' && setting require_2fa && !totp_enabled`.
  Every attempt writes `login_events` with reason `ok | unknown_email | bad_password | locked | inactive | totp_required | totp_invalid`. Ten consecutive failures set `locked_until = now + 15 min`; success resets `failed_logins`. Unknown email still runs `verifyPassword(DUMMY_HASH, …)`.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // owner with 2FA: login without code → 401 totp_required, no Set-Cookie; with code → 200, Set-Cookie dl_session HttpOnly SameSite=Lax Path=/
  // affiliate login with '  AFF@Example.com ' → 200 (email case/space, Review Focus 1)
  // unknown email and wrong password → identical bodies { code: 'invalid_credentials' }
  // 10 wrong passwords then the right one → 401 invalid_credentials; clock +15 min → 200
  // 6th request in a minute from one IP → 429 too_many_attempts
  // suspended user with right password → 401 invalid_credentials, login_events.reason 'inactive'
  // GET /me with cookie → Me; clock +12h01 without activity → 401 unauthenticated
  // remember=false: clock advanced in 11 h steps with a request each time → 401 after 24 h; remember=true → still 200 at 25 h
  // super_manager without 2FA, setting on → login 200 with mustEnroll2fa true; GET /api/health ok;
  //   a permission route → 403 2fa_enrollment_required
  // logout → 204; same cookie on /me → 401
  // POST /login without x-requested-with → 403 csrf
  ```
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add sessions, login with lockout and 2FA check, logout and me`.

### Task 8: Two-factor enrollment and password change

**Files:**
- Create: `src/modules/auth/two-factor.ts` (routes added to `routes.ts`)
- Test: `src/modules/auth/two-factor.test.ts`

**Interfaces:**
- Routes (all `authenticated`, `allowDuring2faEnrollment: true`):
  | Path | Body | Result |
  |---|---|---|
  | `POST /api/auth/2fa/setup` | — | `200 { otpauthUrl, secret }`; stores encrypted pending secret, `totp_enabled` stays false; `409 already_enabled` if on |
  | `POST /api/auth/2fa/enable` | `{ code }` | `204`; `400 totp_invalid` |
  | `POST /api/auth/2fa/disable` | `{ password, code }` | `204`; `403 2fa_required_for_role` for Super Managers while the setting is on |
  | `POST /api/auth/password/change` | `{ currentPassword, newPassword }` | `204`, other sessions revoked; `400 { code: 'validation', errors: { newPassword } }` per policy; `401 invalid_credentials` |
  Each success writes an audit entry (`auth.2fa_enabled`, `auth.2fa_disabled`, `auth.password_changed`) with no secrets in `before`/`after`. Login (Task 7) and enable both record the matched step in `totp_last_step` and reject a step `<=` it.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // setup → enable with a code from the returned secret → /me twoFactorEnabled true, mustEnroll2fa false
  // the same code used again at login within 90 s → 401 totp_invalid (Review Focus 5)
  // owner disable → 403 2fa_required_for_role; affiliate disable with password+code → 204
  // password change with 'password123' → 400 errors.newPassword; valid → 204, a second session's cookie now → 401
  // audit_log rows for these actions contain neither the secret nor the passwords
  ```
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(api): add 2FA enrollment, disable rules and password change`.

### Task 9: Invitations and password reset

**Files:**
- Create: `src/modules/auth/tokens.ts` (routes in `routes.ts`)
- Test: `src/modules/auth/tokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INVITE_TTL_MS = 7 * 24 * 3600_000, RESET_TTL_MS = 30 * 60_000;
  export async function issueToken(db: Db, p: { userId: string; type: 'invite' | 'password_reset'; now: Date }): Promise<string>; // invalidates earlier unused tokens of that type
  export async function consumeToken(db: Db, p: { token: string; type: 'invite' | 'password_reset'; now: Date }): Promise<{ userId: string } | null>; // single use, in a transaction
  ```
- Routes (public; rate limit 10 per 15 min per IP):
  | Path | Body | Result |
  |---|---|---|
  | `GET /api/auth/invite/:token` | — | `200 { email, fullName }` without consuming; `404` if invalid, used, expired, or user not `invited` |
  | `POST /api/auth/invite/accept` | `{ token, password }` | `204`; user `invited → active`, password set; `400 invalid_token`; `400 validation` |
  | `POST /api/auth/password/forgot` | `{ email }` | always `204`; mails a link only to `active` users; rate limit 5 per 15 min per IP |
  | `POST /api/auth/password/reset` | `{ token, password }` | `204`, all sessions revoked, `failed_logins` and `locked_until` cleared; `400 invalid_token` |
  Links: `${APP_ORIGIN}/invitation?token=…` and `${APP_ORIGIN}/reinitialiser?token=…`.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // forgot for unknown email → 204, no mail; for active user → 204, one mail whose link token resets the password
  // reset token reused → 400 invalid_token; clock +31 min → 400 invalid_token
  // reset for a user suspended after the mail was sent → 400 invalid_token, status stays suspended (Review Focus 3)
  // invite accept → 204, login works; accepting the same token again → 400 invalid_token
  // invite accept for a user suspended before accepting → 400 invalid_token
  // a second forgot request makes the first link invalid
  ```
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(api): add invitation acceptance and password reset`.

### Task 10: User management

**Files:**
- Create: `src/modules/users/service.ts`, `src/modules/users/routes.ts`
- Test: `src/modules/users/users.test.ts`

**Interfaces:**
- Produces: `UserDto` (Task 3 `userSchema`) for every response.
- Routes (access `permission: 'users.manage'` unless stated; page size 50):
  | Method, path | Body / query | Result |
  |---|---|---|
  | `GET /api/users` | `?role&status&q&page` (q matches name, email, phone) | `200 { items: User[], total }` |
  | `POST /api/users` | `{ email, fullName, phone?, role, permissions?, isOwner? }` | `201 User`, invite mailed; `409 email_taken` |
  | `GET /api/users/:id` | — | `200 User`; `404` |
  | `PATCH /api/users/:id` | `{ fullName?, phone?, role?, permissions?, isOwner? }` | `200 User` |
  | `POST /api/users/:id/suspend` · `/reactivate` · `/resend-invite` · `/revoke-sessions` | `{ reason? }` | `204` |
- Rules:
  - Creating, editing, suspending or granting permissions to a **Super Manager**, and setting `isOwner`, need an owner → else `403 owner_required`.
  - `permissions` and `isOwner` are only valid for `super_manager` → else `400 validation`.
  - Nobody can suspend themselves or remove their own owner flag if they are the last active owner → `409 last_owner`. Owner demotion and suspension lock all owner rows (`SELECT … FOR UPDATE`) inside the transaction.
  - Changes to role, permissions, owner flag or status revoke the target's sessions; suspension also blocks login (Task 7).
  - `resend-invite` only for `invited` users → else `409 not_invited`.
  - Phone stored through `normalizePhone`; invalid → `400 validation`.
  - Every change writes `audit_log` (`user.created`, `user.updated`, `user.suspended`, `user.reactivated`, `user.invite_resent`, `user.sessions_revoked`) with `before`/`after` excluding hashes and secrets.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // super manager with users.manage creates an affiliate with email ' Aya@Mail.com ' → 201, email 'aya@mail.com', invite mail sent
  // same email again in different case → 409 email_taken (Review Focus 1)
  // non-owner with users.manage creating a super_manager → 403 owner_required
  // owner grants ['audit.read'] to a super manager who is logged in → that session's next request to an audit.read route → 401 (sessions revoked),
  //   and after logging in again → allowed; removing it → the next request is 403 (Review Focus 4)
  // two owners A and B; parallel PATCH A→{isOwner:false} by B and B→{isOwner:false} by A → exactly one 409 last_owner (Review Focus 2)
  // affiliate GET /api/users → 403 forbidden; affiliate GET /api/users/:id of someone → 403 (route-level), never data
  // suspend → 204, target cannot log in, audit row with before.status 'active' after.status 'suspended'
  // list ?q=aya returns only matching users; ?role=affiliate filters
  ```
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(api): add user management with owner rules and session revocation`.

### Task 11: Audit log, login log and settings APIs; owner bootstrap CLI

**Files:**
- Create: `src/modules/audit/routes.ts`, `src/modules/settings/routes.ts`, `src/cli/create-owner.ts`
- Test: `src/modules/audit/audit.test.ts`, `src/modules/settings/settings.test.ts`, `src/cli/create-owner.test.ts`

**Interfaces:**
- Routes:
  | Method, path | Access | Result |
  |---|---|---|
  | `GET /api/audit-log?entityType&actorId&from&to&page` | `audit.read` | `{ items: { id, at, actor: { id, fullName } \| null, action, entityType, entityId, before, after, reason }[], total }` newest first |
  | `GET /api/login-events?email&success&from&to&page` | `audit.read` | `{ items: { id, at, email, success, reason, ip }[], total }` |
  | `GET /api/settings` | `settings.manage` | `{ [key]: value }` for every key in `SETTINGS`, defaults filled |
  | `PATCH /api/settings/:key` | `settings.manage` | `200 { key, value }`; `404` unknown key; `400 validation`; audit `setting.updated` |
  `from`/`to` are Algiers calendar dates (`YYYY-MM-DD`) converted to UTC bounds.
- CLI: `pnpm --filter @darling/api create-owner --email <e> --name "<n>"` creates an `invited` owner and prints the invitation link (also mails it). Refuses with exit code 1 if any owner already exists, unless `--force`.

- [ ] **Step 1: Write failing tests.**
  ```ts
  // audit-log filtered by from/to: an entry at 2026-11-09T23:30Z (00:30 on 10 Nov in Algiers) is returned for from=to=2026-11-10
  // affiliate → 403; super manager without audit.read → 403
  // PATCH settings security.require_2fa_super_managers 'yes' → 400; false → 200, audit row, /me of a super manager without 2FA → mustEnroll2fa false
  // create-owner on an empty DB → exit 0, one owner invited, link printed; second run → exit 1
  ```
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(api): add audit and login log, settings APIs and owner bootstrap CLI`.

### Task 12: Route access audit

**Files:**
- Create: `apps/api/test/access-matrix.test.ts`

**Interfaces:**
- Consumes: every route from Tasks 4–11.
- Produces: one table-driven test listing every `METHOD path` and its expected status for `anonymous`, `affiliate`, `sub_manager`, `super_manager` (no permissions, 2FA on), `super_manager` holding the route's permission, `owner`. A route found in `app.printRoutes()` but missing from the table fails the test, so later sub-projects must extend it.

- [ ] **Step 1:** Write the table and the "every registered route is listed" check. Run. Expected: PASS for listed routes; temporarily remove one row to see the completeness check fail, then restore.
- [ ] **Step 2: Commit** `test(api): add route access matrix with completeness check`.

### Task 13: UI package — tokens and portal components

**Files:**
- Create: `packages/ui/` (`@darling/ui`), `src/tokens.css` (the `:root` variables, `.glass`, `.icon` rules and keyframes moved from `apps/web/app/globals.css`), `src/portal.css`, components per file map, `src/index.ts`
- Modify: `apps/web/app/globals.css` (import tokens from `@darling/ui/tokens.css` instead of defining them), `apps/web/next.config.ts` (`transpilePackages: ['@darling/ui', '@darling/shared']`)
- Test: `packages/ui/src/components.test.tsx` (Vitest + jsdom + Testing Library)

**Interfaces:**
- Produces:
  ```tsx
  AppShell({ brand?: string; nav: { href: string; label: string; icon?: ReactNode }[]; currentPath: string;
    user: { fullName: string; roleLabel: string }; onLogoutHref: string; children })   // sidebar ≥ 1000 px, top bar + drawer below
  Button({ variant?: 'primary'|'ghost'|'danger'; busy?: boolean; ...button props })   // primary = storefront .submit look
  Field({ label: string; error?: string; hint?: string; children })                   // input/select styled like the order form
  Table<T>({ columns: { key: string; header: string; render(row: T): ReactNode; hideBelow?: 'sm'|'md' }[]; rows: T[]; empty: ReactNode })
                                                                                       // rows become cards below 700 px
  Badge({ tone: 'neutral'|'pink'|'success'|'warning'|'danger'; children })
  PageHeader({ eyebrow?: string; title: string; actions?: ReactNode })
  Notice({ tone: 'info'|'error'|'success'; children })
  ```
  Portal styling reuses `--pink`, `--paper`, `--ink`, `--line`, `.glass`, DM Sans for text, Space Grotesk for headings, 11 px uppercase eyebrows with 1.8 px letter spacing, radius 14–25 px, as in the storefront.

- [ ] **Step 1: Write failing tests.** `AppShell` marks the nav item whose `href` prefixes `currentPath` with `aria-current="page"`; `Field` links its error to the input with `aria-describedby` and sets `aria-invalid`; `Button busy` is disabled with `aria-busy="true"`; `Table` renders `empty` when `rows` is empty.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). Then run the storefront parity probe from the clone (reference snapshot in an iframe, see `apps/web/README.md`) at 1440, 768, 375 px. Expected: zero differences.
- [ ] **Step 5: Commit** `feat(ui): add shared tokens and portal components in the Darling style`.

### Task 14: Web — API helpers, session gate and auth pages

**Files:**
- Create: `apps/web/lib/api/server.ts`, `apps/web/lib/api/client.ts`, `apps/web/lib/auth/session.ts`, `apps/web/proxy.ts`, `apps/web/app/(auth)/layout.tsx`, `(auth)/connexion/page.tsx`, `(auth)/mot-de-passe-oublie/page.tsx`, `(auth)/reinitialiser/page.tsx`, `(auth)/invitation/page.tsx`
- Modify: `apps/web/next.config.ts` (rewrites `afterFiles: [{ source: '/api/:path*', destination: `${API_INTERNAL_URL}/api/:path*` }]`, so the storefront's own `app/api/orders` keeps working until sub-project 3)
- Test: `apps/web/lib/api/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // client.ts (browser)
  export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: Record<string, string> };
  export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>>; // sends X-Requested-With: fetch, JSON
  // server.ts (server components / actions)
  export async function apiServer<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>>; // forwards the session cookie, Origin = APP_ORIGIN
  // session.ts
  export async function getMe(): Promise<Me | null>;
  export async function requireUser(allowed: Role[]): Promise<Me>;  // null → redirect('/connexion?next=…'); wrong role → redirect(homePathFor(me.role)); mustEnroll2fa → redirect('/compte/securite?setup=1')
  ```
  `proxy.ts` matcher `['/admin/:path*', '/manager/:path*', '/affiliate/:path*', '/compte/:path*']`: no session cookie → redirect to `/connexion?next=<path>`. It does not validate the session; layouts do.
  `next.config.ts` `headers()` for every path: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `COOKIE_SECURE=true`. A full Content-Security-Policy is sent as `Content-Security-Policy-Report-Only` now and enforced in sub-project 8 after nonce support is checked against the storefront.
  Pages read cookies, so with `cacheComponents` they wrap dynamic parts in `<Suspense>` (see `node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`).
- Page behaviour (French copy):
  - **Connexion:** email, password, "Rester connectée" checkbox; on `totp_required` shows a 6-digit code step; errors: `invalid_credentials` → "E-mail ou mot de passe incorrect.", `too_many_attempts` → "Trop de tentatives. Réessayez dans une minute." On success → `next` if it is a same-site path, else `homePathFor(role)`.
  - **Mot de passe oublié:** always shows "Si un compte existe pour cette adresse, un lien vient d'être envoyé."
  - **Réinitialiser / Invitation:** password + confirmation with the policy message from `passwordProblem`; invitation shows the invitee's name from `GET /api/auth/invite/:token`; invalid link → "Ce lien n'est plus valide." with a link to "Mot de passe oublié".
  Visual style: centred glass card on the storefront's paper background with the DARLING wordmark.

- [ ] **Step 1: Write failing tests** for `api()`: sends `X-Requested-With: fetch` and JSON body; maps a `400 { code: 'validation', errors }` response to `{ ok: false, status: 400, code: 'validation', errors }`; maps a network error to `{ ok: false, status: 0, code: 'network' }`.
- [ ] **Step 2–4:** Run (FAIL), implement helpers and pages, run (PASS). Then with `pnpm infra:up`, API and web running, log in through the browser as a seeded affiliate and land on `/affiliate`.
- [ ] **Step 5: Commit** `feat(web): add API helpers, portal gate and authentication pages`.

### Task 15: Web — portal shells, account security and admin screens

**Files:**
- Create: `apps/web/app/(portal)/admin/layout.tsx`, `admin/page.tsx`, `admin/utilisateurs/page.tsx`, `admin/utilisateurs/nouveau/page.tsx`, `admin/utilisateurs/[id]/page.tsx`, `admin/journal/page.tsx`, `admin/parametres/page.tsx`, `manager/layout.tsx`, `manager/page.tsx`, `affiliate/layout.tsx`, `affiliate/page.tsx`, `compte/layout.tsx`, `compte/securite/page.tsx`
- Modify: `apps/web/package.json` (add `qrcode`)

**Interfaces:**
- Consumes: Task 13 components, Task 14 helpers, API routes of Tasks 7–11.
- Layouts call `requireUser([...])` for their role and render `AppShell` with:
  - admin nav: Tableau de bord `/admin`, Utilisateurs `/admin/utilisateurs` (if `users.manage`), Journal `/admin/journal` (if `audit.read`), Paramètres `/admin/parametres` (if `settings.manage`), Mon compte `/compte/securite`
  - manager nav: Tableau de bord `/manager`, Mon compte
  - affiliate nav: Tableau de bord `/affiliate`, Mon compte
- Screens:
  - Dashboards: welcome header with the user's name and a "bientôt disponible" notice listing what later sub-projects add.
  - Utilisateurs: table (name, email, role badge, status badge, 2FA, last login), filters role/status, search; "Nouvel utilisateur" form (role select shows Super Manager only to owners; permission checkboxes with French labels only for Super Manager); detail page with edit, suspend/reactivate (confirmation dialog with reason), resend invite, revoke sessions; API errors shown next to fields or as a `Notice` (`owner_required` → "Seul un propriétaire peut modifier un Super Manager.", `last_owner` → "Il doit rester au moins un propriétaire actif.", `email_taken` → "Cette adresse est déjà utilisée.").
  - Journal: two tabs, audit log and connexions, date filters, paging.
  - Paramètres: the two settings from `SETTINGS` with save buttons.
  - Mon compte / sécurité: change password; 2FA setup with QR code (SVG from `qrcode`) and the secret text, enable with code, disable when allowed; `?setup=1` shows "La double authentification est obligatoire pour votre rôle." and hides navigation until enabled.

- [ ] **Step 1:** Implement layouts and screens.
- [ ] **Step 2: Verify in the browser** (dev servers running): as owner, create a sub-manager and an affiliate; accept both invites from Mailpit; each lands on its portal; the affiliate typing `/admin` is sent back to `/affiliate`; a 375 px viewport shows the drawer navigation and card rows; no console errors.
- [ ] **Step 3:** `pnpm lint && pnpm typecheck && pnpm build`. Expected: pass.
- [ ] **Step 4: Commit** `feat(web): add admin, manager and affiliate portal shells and account security`.

### Task 16: End-to-end tests and documentation

**Files:**
- Create: `apps/web/playwright.config.ts` (starts API and web; requires `pnpm infra:up`), `apps/web/e2e/foundation.spec.ts`, `docs/foundation.md`
- Modify: root `README.md`, `.github/workflows/ci.yml` (Playwright job)

**Interfaces:**
- Consumes: everything above. Test data created with `create-owner` and the API.

- [ ] **Step 1: Write the end-to-end tests.**
  ```ts
  test('owner bootstrap → 2FA enrollment → invite sub-manager → sub-manager logs in to /manager and cannot open /admin')
  test('forgotten password e-mail resets the password and old sessions stop working')
  test('ten wrong passwords lock the account; the message never reveals whether the e-mail exists')
  test('affiliate on a 375 px screen sees the drawer navigation and her dashboard')
  test('storefront home still renders the Wet Kiss page and its order form')
  ```
  Mails are read from the Mailpit API (`GET http://localhost:8025/api/v1/messages`). TOTP codes are computed from the secret shown on the setup screen.
- [ ] **Step 2:** `pnpm --filter @darling/web exec playwright install chromium` (downloads the browser; ask the owner first), then run the suite. Expected: 5 passed.
- [ ] **Step 3:** `docs/foundation.md`: how to start everything locally, create the first owner, environment variables, how to add an API route (declare `access`, add a row to the access matrix), and where the audit log lives. Update root `README.md` with the workspace layout and commands.
- [ ] **Step 4:** Full check: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Expected: all pass; storefront still 63 tests.
- [ ] **Step 5: Commit** `test: add foundation end-to-end tests and documentation`.

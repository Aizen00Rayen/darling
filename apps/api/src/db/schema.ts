import { PERMISSIONS, ROLES, USER_STATUSES } from '@darling/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 } from 'uuid';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => v7());

/** Renders `'a', 'b'` for use inside a CHECK (col in (...)) expression. */
const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));

export const AUTH_TOKEN_TYPES = ['invite', 'password_reset'] as const;
export type AuthTokenType = (typeof AUTH_TOKEN_TYPES)[number];

export const users = pgTable(
  'users',
  {
    id: id(),
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    role: text('role').notNull().$type<(typeof ROLES)[number]>(),
    status: text('status').notNull().default('invited').$type<(typeof USER_STATUSES)[number]>(),
    isOwner: boolean('is_owner').notNull().default(false),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    lastLoginAt: timestamptz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('users_role_check', sql`${t.role} in (${inList(ROLES)})`),
    check('users_status_check', sql`${t.status} in (${inList(USER_STATUSES)})`),
    check('users_owner_is_super_manager_check', sql`not ${t.isOwner} or ${t.role} = 'super_manager'`),
  ],
);

export const userPermissions = pgTable(
  'user_permissions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull().$type<(typeof PERMISSIONS)[number]>(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.permission] }),
    check('user_permissions_permission_check', sql`${t.permission} in (${inList(PERMISSIONS)})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    remember: boolean('remember').notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull().$type<AuthTokenType>(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('auth_tokens_type_check', sql`${t.type} in (${inList(AUTH_TOKEN_TYPES)})`),
    index('auth_tokens_user_id_idx').on(t.userId),
  ],
);

export const loginEvents = pgTable(
  'login_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    emailTried: text('email_tried').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    success: boolean('success').notNull(),
    reason: text('reason'),
    at: timestamptz('at').notNull().defaultNow(),
  },
  (t) => [index('login_events_user_id_idx').on(t.userId), index('login_events_at_idx').on(t.at)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    ip: text('ip'),
    requestId: text('request_id'),
    at: timestamptz('at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorUserId),
    index('audit_log_at_idx').on(t.at),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

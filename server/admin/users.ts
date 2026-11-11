import { effectivePermissions, PERMISSIONS, PHONE_REQUIRED_MESSAGE, PHONE_REQUIRED_ROLES, type CreateUserInput, type Permission, type Role, type UpdateUserInput, type User, type UserStatus } from '@/shared';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db, Scalar } from '../db/sqlite';
import { recordAudit } from '../audit';
import { revokeUserSessions } from '../auth/sessions';
import { issueInviteMail } from '../auth/tokens';
import { createProfile, readAffiliateInfo, readProfile, setManager } from '../affiliates/profiles';
import { newId } from '../ids';
import { log } from '../log';
import type { Mail, Mailer } from '../mail/mailer';
import { sendMailInBackground } from '../mail/outbox';
import { forbidden, HttpFailure, isUniqueViolation, notFound, ownerRequired, validation } from './errors';

// User management. Every mutation runs in ONE `BEGIN IMMEDIATE` transaction (SQLite serialises writers, which
// replaces the row locks of the Postgres version) that re-reads, from the database as it stands NOW:
//   - the ACTOR: must still be an active super manager holding users.manage (owners hold it implicitly), and
//     whether they are an owner is judged from that fresh row, never from the principal loaded at request start;
//   - the TARGET and every OWNER row, which the owner rules and the last-owner invariant are decided on.
// So an owner demoted/suspended between a request's authentication and its mutation cannot complete an owner-only
// action, and two owners removing each other can never both succeed: the second transaction sees the first one.

export const PAGE_SIZE = 50;

export interface UsersDeps {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'appOrigin'>;
  mailer: Mailer;
}

/** Who acts. Only the id is trusted: authority is re-read inside every transaction. */
export interface Actor {
  userId: string;
  ip: string;
  requestId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  email: string;
  password_hash: string | null;
  full_name: string;
  phone: string | null;
  role: Role;
  status: UserStatus;
  is_owner: number;
  totp_enabled: number;
  last_login_at: number | null;
  created_at: number;
}
// Never selects the authenticator secret.
const COLUMNS = 'id, email, password_hash, full_name, phone, role, status, is_owner, totp_enabled, last_login_at, created_at';

/** An unknown id and one that is not an id at all look the same, so ids cannot be probed. */
function assertId(id: string): void {
  if (!UUID.test(id)) throw notFound();
}

function sortGrants(list: readonly Permission[]): Permission[] {
  return PERMISSIONS.filter((p) => list.includes(p));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function toDto(row: Row, grants: Permission[], affiliate?: User['affiliate']): User {
  const isOwner = row.is_owner === 1;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    status: row.status,
    isOwner,
    permissions: effectivePermissions({ role: row.role, isOwner, granted: grants }),
    twoFactorEnabled: row.totp_enabled === 1,
    lastLoginAt: row.last_login_at === null ? null : new Date(row.last_login_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    ...(affiliate ? { affiliate } : {}),
  };
}

/** What an audit entry may say about a user: nothing that is a credential (no hash, no secret, no token). */
function snapshot(row: Row, grants: Permission[]) {
  return {
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.status,
    isOwner: row.is_owner === 1,
    permissions: grants,
  };
}

function loadGrants(db: Db, userId: string): Permission[] {
  return sortGrants(db.all<{ permission: Permission }>('SELECT permission FROM user_permissions WHERE user_id = ?', userId).map((r) => r.permission));
}

function readUser(db: Db, id: string): Row | undefined {
  return db.get<Row>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
}

// --- authority --------------------------------------------------------------------------------------

interface Authority {
  isOwner: boolean;
}

/**
 * The actor, judged on the database as it stands now. 403 `forbidden` when they are not an active super manager
 * holding users.manage (any more). Owners hold every permission.
 */
function authoriseActor(tx: Db, actor: Actor): Authority {
  const self = tx.get<{ status: string; role: Role; is_owner: number }>('SELECT status, role, is_owner FROM users WHERE id = ?', actor.userId);
  if (!self || self.status !== 'active' || self.role !== 'super_manager') throw forbidden();
  if (self.is_owner === 1) return { isOwner: true };
  const grant = tx.get("SELECT 1 AS ok FROM user_permissions WHERE user_id = ? AND permission = 'users.manage'", actor.userId);
  if (!grant) throw forbidden();
  return { isOwner: false };
}

interface Locked {
  target: Row;
  grants: Permission[];
  /** Every owner as it stands now, whatever its status. */
  owners: { id: string; status: UserStatus }[];
  now: number;
  self: Authority;
}

/** Runs `change` in one immediate transaction, after the actor is re-authorised and the target and owners are read. */
function mutate<T>(deps: UsersDeps, actor: Actor, id: string, change: (tx: Db, locked: Locked) => T): T {
  assertId(id);
  return deps.db.transaction((tx) => {
    const self = authoriseActor(tx, actor);
    const target = readUser(tx, id);
    if (!target) throw notFound();
    const owners = tx.all<{ id: string; status: UserStatus }>('SELECT id, status FROM users WHERE is_owner = 1');
    return change(tx, { target, grants: loadGrants(tx, id), owners, now: deps.clock.now(), self });
  }, 'immediate');
}

/** Only an owner manages super managers (design section 4.1). */
function requireOwnerFor(target: Pick<Row, 'role'>, self: Authority): void {
  if (target.role === 'super_manager' && !self.isOwner) throw ownerRequired();
}

function assertNotLastOwner(owners: Locked['owners'], target: Row): void {
  if (target.is_owner === 1 && target.status === 'active' && !owners.some((o) => o.status === 'active' && o.id !== target.id)) {
    throw new HttpFailure(409, 'last_owner');
  }
}

// --- reads ------------------------------------------------------------------------------------------

export interface ListFilter {
  role?: Role;
  status?: UserStatus;
  q?: string;
  page: number;
}

/** `%`, `_` and the escape character itself must match literally in a LIKE pattern. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

export function listUsers(db: Db, filter: ListFilter): { items: User[]; total: number } {
  const where: string[] = [];
  const params: Record<string, Scalar> = {};
  if (filter.role) {
    where.push('role = :role');
    params.role = filter.role;
  }
  if (filter.status) {
    where.push('status = :status');
    params.status = filter.status;
  }
  const term = filter.q?.trim();
  if (term) {
    // LIKE is case-insensitive for ASCII letters (the e-mail column is NOCASE as well).
    where.push("(full_name LIKE :q ESCAPE '\\' OR email LIKE :q ESCAPE '\\' OR phone LIKE :q ESCAPE '\\')");
    params.q = `%${escapeLike(term)}%`;
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all<Row>(`SELECT ${COLUMNS} FROM users ${clause} ORDER BY created_at DESC, id ASC LIMIT :limit OFFSET :offset`, {
    ...params,
    limit: PAGE_SIZE,
    offset: (filter.page - 1) * PAGE_SIZE,
  });
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM users ${clause}`, params)?.n ?? 0;

  const granted = new Map<string, Permission[]>();
  if (rows.length > 0) {
    const marks = rows.map(() => '?').join(', ');
    for (const g of db.all<{ user_id: string; permission: Permission }>(`SELECT user_id, permission FROM user_permissions WHERE user_id IN (${marks})`, ...rows.map((r) => r.id))) {
      granted.set(g.user_id, [...(granted.get(g.user_id) ?? []), g.permission]);
    }
  }
  return { items: rows.map((r) => toDto(r, sortGrants(granted.get(r.id) ?? []))), total };
}

export function getUser(db: Db, id: string): User {
  assertId(id);
  const row = readUser(db, id);
  if (!row) throw notFound();
  return toDto(row, loadGrants(db, id), readAffiliateInfo(db, id));
}

// --- create -----------------------------------------------------------------------------------------

/**
 * Creates an `invited` user with no password, writes the audit row and issues the invitation, all in one
 * transaction. The invitation mail goes out AFTER the commit, in the background: a mail failure neither undoes
 * the account nor fails the request (the user stays invited; the invitation can be re-sent).
 */
export function createUser(deps: UsersDeps, actor: Actor, input: CreateUserInput): User {
  if (input.role !== 'super_manager') {
    const errors: Record<string, string> = {};
    if (input.permissions !== undefined) errors.permissions = 'Les permissions ne concernent que les super managers.';
    if (input.isOwner !== undefined) errors.isOwner = 'Le statut de propriétaire ne concerne que les super managers.';
    if (Object.keys(errors).length > 0) throw validation(errors);
  }
  if ((PHONE_REQUIRED_ROLES as readonly string[]).includes(input.role) && !input.phone) throw validation({ phone: PHONE_REQUIRED_MESSAGE });
  const email = input.email.trim().toLowerCase();
  const isOwner = input.role === 'super_manager' && input.isOwner === true;
  // An owner holds every permission implicitly: grant rows are never written for one.
  const grants = input.role === 'super_manager' && !isOwner ? sortGrants(input.permissions ?? []) : [];
  if (input.role !== 'affiliate' && input.managerUserId !== undefined && input.managerUserId !== null) {
    throw validation({ managerUserId: 'Le sous-manager ne concerne que les influenceuses.' });
  }

  let created: { row: Row; mail: Mail; affiliate: User['affiliate'] };
  try {
    created = deps.db.transaction((tx) => {
      const self = authoriseActor(tx, actor);
      if (input.role === 'super_manager' && !self.isOwner) throw ownerRequired();
      if (tx.get('SELECT 1 AS taken FROM users WHERE email = ?', email)) throw new HttpFailure(409, 'email_taken');
      const now = deps.clock.now();
      const id = newId(deps.clock);
      tx.run(
        `INSERT INTO users (id, email, full_name, phone, role, status, is_owner, created_at, updated_at)
         VALUES (:id, :email, :name, :phone, :role, 'invited', :owner, :now, :now)`,
        { id, email, name: input.fullName, phone: input.phone ?? null, role: input.role, owner: isOwner, now },
      );
      for (const permission of grants) tx.run('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)', id, permission);
      const row = readUser(tx, id) as Row;
      // An influenceuse gets her profile and code in this same transaction (a failure rolls the account back too).
      if (input.role === 'affiliate') createProfile(tx, actor, { id, fullName: row.full_name }, input.managerUserId ?? null, now, input.affiliateCode);
      recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        after: snapshot(row, grants),
        ip: actor.ip,
        requestId: actor.requestId,
        at: now,
      });
      const mail = issueInviteMail(deps, tx, { id, email, fullName: row.full_name, role: row.role });
      return { row, mail, affiliate: input.role === 'affiliate' ? readAffiliateInfo(tx, id) : undefined };
    }, 'immediate');
  } catch (err) {
    // A racing writer can still win at the unique index; it is the same answer as the pre-check's.
    if (isUniqueViolation(err, 'users.email')) throw new HttpFailure(409, 'email_taken');
    throw err;
  }
  sendMailInBackground(deps.mailer, created.mail, 'mail.invite_failed');
  return toDto(created.row, grants, created.affiliate);
}

// --- update -----------------------------------------------------------------------------------------

export type UpdateInput = UpdateUserInput & { reason?: string | undefined };

export function updateUser(deps: UsersDeps, actor: Actor, id: string, input: UpdateInput): User {
  return mutate(deps, actor, id, (tx, { target, grants, owners, now, self: authority }) => {
    const isSelf = target.id === actor.userId;
    const newRole = input.role ?? target.role;
    const roleChanged = newRole !== target.role;
    const newOwner = input.isOwner ?? target.is_owner === 1;
    const ownerChanged = newOwner !== (target.is_owner === 1);
    // An owner holds every permission: whatever `permissions` a client sends for someone who is, and stays, an
    // owner is ignored (the edit form used to send an owner's effective permissions as grants).
    const staysOwner = newRole === 'super_manager' && newOwner;
    const submittedGrants = input.permissions === undefined || staysOwner ? undefined : sortGrants(input.permissions);
    const grantsChangedByInput = submittedGrants !== undefined && !sameList(submittedGrants, grants);

    // Nobody edits their own role or permissions. This comes before the owner rule so the answer is the same
    // whether or not the caller is an owner. Name and phone are the person's own to edit.
    if (isSelf && (roleChanged || grantsChangedByInput)) throw forbidden();
    const profileOnly = isSelf && !roleChanged && !ownerChanged && !grantsChangedByInput;
    if (!profileOnly) requireOwnerFor(target, authority);
    if (roleChanged && newRole === 'super_manager' && !authority.isOwner) throw ownerRequired();

    // Permissions and the owner flag exist only on super managers.
    const errors: Record<string, string> = {};
    if (newRole !== 'super_manager') {
      if (input.permissions !== undefined) errors.permissions = 'Les permissions ne concernent que les super managers.';
      if (input.isOwner !== undefined) errors.isOwner = 'Le statut de propriétaire ne concerne que les super managers.';
    }
    if (newRole !== 'affiliate' && input.managerUserId !== undefined && input.managerUserId !== null) errors.managerUserId = 'Le sous-manager ne concerne que les influenceuses.';
    const finalPhone = input.phone !== undefined ? input.phone : target.phone;
    if ((PHONE_REQUIRED_ROLES as readonly string[]).includes(newRole) && !finalPhone) errors.phone = PHONE_REQUIRED_MESSAGE;
    if (roleChanged && target.role === 'super_manager' && target.is_owner === 1) errors.role = 'Retirez d’abord le statut de propriétaire.';
    if (Object.keys(errors).length > 0) throw validation(errors);

    // The role cannot change while the user is an owner (checked above), so the flag is the only way to drop an
    // active owner here; suspension has its own check.
    if (ownerChanged && !newOwner) assertNotLastOwner(owners, target);

    let finalGrants: Permission[];
    if (newRole !== 'super_manager') finalGrants = [];
    else if (newOwner) finalGrants = ownerChanged ? [] : grants; // never write grant rows for an owner
    else finalGrants = submittedGrants ?? grants;
    const grantsChanged = !sameList(finalGrants, grants);

    // Influenceuse profile: created when someone becomes one (or never had it), kept when they stop being one.
    const profile = readProfile(tx, target.id);
    const needsProfile = newRole === 'affiliate' && !profile;
    const wantedManager = input.managerUserId === undefined || newRole !== 'affiliate' ? undefined : input.managerUserId;
    const managerChanged = wantedManager !== undefined && wantedManager !== (profile?.manager_user_id ?? null);

    const fullName = input.fullName !== undefined && input.fullName !== target.full_name ? input.fullName : undefined;
    const phoneChanged = input.phone !== undefined && input.phone !== target.phone;
    const phone = phoneChanged ? (input.phone ?? null) : null;
    if (fullName === undefined && !phoneChanged && !roleChanged && !ownerChanged && !grantsChanged && !needsProfile && !managerChanged) {
      return toDto(target, grants, readAffiliateInfo(tx, target.id));
    }

    tx.run(
      `UPDATE users SET full_name = COALESCE(:name, full_name), phone = CASE WHEN :setPhone THEN :phone ELSE phone END, role = :role, is_owner = :owner, updated_at = :now
       WHERE id = :id`,
      { name: fullName ?? null, setPhone: phoneChanged, phone, role: newRole, owner: newOwner, now, id: target.id },
    );
    if (grantsChanged) {
      tx.run('DELETE FROM user_permissions WHERE user_id = ?', target.id);
      for (const permission of finalGrants) tx.run('INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)', target.id, permission);
    }
    const profileActor = { userId: actor.userId, ip: actor.ip, requestId: actor.requestId };
    if (needsProfile) createProfile(tx, profileActor, { id: target.id, fullName: fullName ?? target.full_name }, wantedManager ?? null, now);
    else if (managerChanged) setManager(tx, profileActor, target.id, wantedManager ?? null, now);
    // Design 4.4.5: a change of role, permissions or owner flag takes effect at once, not at next login.
    if (roleChanged || grantsChanged || ownerChanged) revokeUserSessions(tx, target.id, undefined, now);

    const updated = readUser(tx, target.id) as Row;
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.updated',
      entityType: 'user',
      entityId: target.id,
      before: snapshot(target, grants),
      after: snapshot(updated, finalGrants),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return toDto(updated, finalGrants, readAffiliateInfo(tx, target.id));
  });
}

// --- status changes ---------------------------------------------------------------------------------

export interface ActionInput {
  reason?: string | undefined;
}

function auditStatusChange(tx: Db, actor: Actor, action: string, before: Row, after: Row, grants: Permission[], reason: string | undefined, now: number): void {
  recordAudit(tx, {
    actorUserId: actor.userId,
    action,
    entityType: 'user',
    entityId: before.id,
    before: snapshot(before, grants),
    after: snapshot(after, grants),
    ...(reason === undefined ? {} : { reason }),
    ip: actor.ip,
    requestId: actor.requestId,
    at: now,
  });
}

export function suspendUser(deps: UsersDeps, actor: Actor, id: string, input: ActionInput): void {
  mutate(deps, actor, id, (tx, { target, grants, owners, now, self }) => {
    if (target.id === actor.userId) throw new HttpFailure(409, 'cannot_suspend_self');
    requireOwnerFor(target, self);
    if (target.status === 'deactivated') throw new HttpFailure(409, 'invalid_status');
    if (target.status === 'suspended') return; // already done: no second audit row
    assertNotLastOwner(owners, target);
    tx.run("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", now, target.id);
    revokeUserSessions(tx, target.id, undefined, now);
    auditStatusChange(tx, actor, 'user.suspended', target, readUser(tx, target.id) as Row, grants, input.reason, now);
  });
}

export function reactivateUser(deps: UsersDeps, actor: Actor, id: string, input: ActionInput): void {
  mutate(deps, actor, id, (tx, { target, grants, now, self }) => {
    requireOwnerFor(target, self);
    if (target.status !== 'suspended') throw new HttpFailure(409, 'not_suspended');
    // Someone who never set a password goes back to waiting for their invitation.
    const status: UserStatus = target.password_hash === null ? 'invited' : 'active';
    tx.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, now, target.id);
    revokeUserSessions(tx, target.id, undefined, now);
    auditStatusChange(tx, actor, 'user.reactivated', target, readUser(tx, target.id) as Row, grants, input.reason, now);
  });
}

export function revokeSessions(deps: UsersDeps, actor: Actor, id: string, input: ActionInput): void {
  mutate(deps, actor, id, (tx, { target, now, self }) => {
    requireOwnerFor(target, self);
    revokeUserSessions(tx, target.id, undefined, now);
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.sessions_revoked',
      entityType: 'user',
      entityId: target.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
  });
}

/**
 * Sends a fresh invitation (older links stop working) to a user who has not accepted one yet. The token and the
 * `user.invite_resent` audit row commit together under the same re-authorisation as every other change; the mail
 * goes out AFTER the commit. Returns false when the transport fails: the new token and the audit row stay (the
 * link was issued but not delivered), and the next resend replaces that token.
 */
export async function resendInvite(deps: UsersDeps, actor: Actor, id: string, input: ActionInput): Promise<{ sent: boolean; link: string }> {
  let link = '';
  const mail = mutate(deps, actor, id, (tx, { target, now, self }) => {
    requireOwnerFor(target, self);
    if (target.status !== 'invited') throw new HttpFailure(409, 'not_invited');
    const issued = issueInviteMail(deps, tx, { id: target.id, email: target.email, fullName: target.full_name, role: target.role });
    link = /https?:\/\/[^\s<>"]+/.exec(issued.text)?.[0] ?? '';
    recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.invite_resent',
      entityType: 'user',
      entityId: target.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ip: actor.ip,
      requestId: actor.requestId,
      at: now,
    });
    return issued;
  });
  try {
    await deps.mailer.send(mail);
    return { sent: true, link };
  } catch (err) {
    // Only the kind of error is logged: a transport error usually quotes the recipient.
    log.error('mail.invite_failed', { userId: id, errName: err instanceof Error ? err.name : 'unknown' });
    return { sent: false, link };
  }
}

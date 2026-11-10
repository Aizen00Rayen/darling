import { and, count, desc, asc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  effectivePermissions,
  PERMISSIONS,
  type CreateUserInput,
  type Permission,
  type Role,
  type UpdateUserInput,
  type User,
  type UserStatus,
} from '@darling/shared';
import type { AppDeps } from '../../app';
import type { Db, DbTx } from '../../db/client';
import { userPermissions, users } from '../../db/schema';
import { apiError, validationError } from '../../plugins/errors';
import { recordAudit } from '../audit/service';
import { revokeUserSessions } from '../auth/sessions';
import { issueInviteMail, sendInvite } from '../auth/tokens';

export const PAGE_SIZE = 50;

type Row = typeof users.$inferSelect;
type Deps = Pick<AppDeps, 'db' | 'mailer' | 'config' | 'clock'>;
type Log = Pick<FastifyBaseLogger, 'error'>;

/** The caller, as the access plugin resolved them at the start of the request. */
export type Actor = { userId: string; isOwner: boolean; ip: string; requestId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => apiError(404, 'not_found');
const ownerRequired = () => apiError(403, 'owner_required');

/** An unknown id and one that is not a UUID at all look the same, so ids cannot be probed. */
function assertId(id: string): void {
  if (!UUID.test(id)) throw notFound();
}

function sortGrants(list: readonly Permission[]): Permission[] {
  return PERMISSIONS.filter((p) => list.includes(p));
}

function toDto(row: Row, grants: Permission[]): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    phone: row.phone,
    role: row.role,
    status: row.status,
    isOwner: row.isOwner,
    permissions: effectivePermissions({ role: row.role, isOwner: row.isOwner, granted: grants }),
    twoFactorEnabled: row.totpEnabled,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * What an audit entry may say about a user: nothing that is a credential. The password hash, the
 * authenticator secret and every token are deliberately absent.
 */
function snapshot(row: Row, grants: Permission[]) {
  return {
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.status,
    isOwner: row.isOwner,
    permissions: grants,
  };
}

async function loadGrants(db: Db | DbTx, userId: string): Promise<Permission[]> {
  const rows = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));
  return sortGrants(rows.map((r) => r.permission));
}

// --- errors -----------------------------------------------------------------------------------

function pgCodeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = cause;
  }
  return undefined;
}

function isEmailTaken(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === '23505' && typeof constraint === 'string' && constraint.includes('email')) return true;
    current = cause;
  }
  return false;
}

function isHttpError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && typeof (err as { apiCode?: unknown }).apiCode === 'string';
}

/**
 * Runs a write. A failure that is not one of our own refusals is logged WITHOUT the error object
 * (a failing Drizzle statement embeds its bound parameters, i.e. the user's data) and re-raised as
 * a bare error, so neither our log nor the generic handler's log can carry a name, email or phone.
 */
async function guarded<T>(log: Log, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isHttpError(err)) throw err;
    if (isEmailTaken(err)) throw apiError(409, 'email_taken');
    log.error({ pgCode: pgCodeOf(err) }, `${what} failed`);
    throw new Error(`${what} failed`);
  }
}

// --- locking ----------------------------------------------------------------------------------

type OwnerRow = { id: string; status: UserStatus };

/**
 * Locks EVERY owner row, in id order, and returns them as they stand once the lock is held.
 * Operations that could remove an active owner count from this result, so two of them can never
 * both see "another owner is left". All user mutations take this lock first (then the target), so
 * they queue in one order and cannot deadlock; the cost is that user changes are serialised, which
 * is fine for an admin screen.
 */
async function lockOwners(tx: DbTx): Promise<OwnerRow[]> {
  return tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.isOwner, true))
    .orderBy(asc(users.id))
    .for('update');
}

type Locked = {
  target: Row;
  grants: Permission[];
  owners: OwnerRow[];
  now: Date;
  /**
   * Re-checks the acting user against the database as it stands now, under the locks. Every change
   * must call it before it writes (`mutate` fails the transaction if it was skipped).
   */
  authorise: (needsOwner: boolean) => Promise<void>;
};

/**
 * The acting user's authority is decided by the request-start snapshot only far enough to refuse
 * early; the request may then have queued behind the owner locks while someone demoted, suspended
 * or stripped that user. So, inside the transaction and after the owner rows are locked, the actor
 * is read again: an owner actor is judged by the locked owner rows (current by construction), any
 * other actor by their own row (`FOR SHARE`) and current grants. The lock order stays owners (by
 * id), then the target, then this read, so it cannot deadlock.
 *
 * - `owner_required` when the change needs an owner and the actor is not an active owner (any more);
 * - `forbidden` when the actor is no longer active, or holds no `users.manage` any more.
 */
async function reauthorise(
  tx: DbTx,
  actor: Actor,
  owners: OwnerRow[],
  needsOwner: boolean,
): Promise<void> {
  const lockedSelf = owners.find((o) => o.id === actor.userId);
  let active: boolean;
  let isActiveOwner: boolean;
  if (lockedSelf) {
    active = lockedSelf.status === 'active';
    isActiveOwner = active;
  } else {
    const [self] = await tx
      .select({ status: users.status, role: users.role, isOwner: users.isOwner })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1)
      .for('share');
    active = self?.status === 'active' && self.role === 'super_manager';
    // Not in the locked owner set, so not an owner: nobody can become one without these locks.
    isActiveOwner = false;
  }

  if (needsOwner && !isActiveOwner) throw ownerRequired();
  if (!active) throw apiError(403, 'forbidden');
  if (isActiveOwner) return; // an owner holds every permission
  const [grant] = await tx
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(and(eq(userPermissions.userId, actor.userId), eq(userPermissions.permission, 'users.manage')))
    .limit(1);
  if (!grant) throw apiError(403, 'forbidden');
}

/**
 * Runs `change` in a transaction that holds the owner locks and the target's row lock, with the
 * target re-read AFTER the locks so every decision is made on current data.
 */
async function mutate<T>(
  deps: Deps,
  log: Log,
  what: string,
  actor: Actor,
  id: string,
  change: (tx: DbTx, locked: Locked) => Promise<T>,
): Promise<T> {
  assertId(id);
  return guarded(log, what, () =>
    deps.db.transaction(async (tx) => {
      const owners = await lockOwners(tx);
      const [target] = await tx.select().from(users).where(eq(users.id, id)).limit(1).for('update');
      if (!target) throw notFound();
      const grants = await loadGrants(tx, id);
      let authorised = false;
      const authorise = async (needsOwner: boolean) => {
        await reauthorise(tx, actor, owners, needsOwner);
        authorised = true;
      };
      const result = await change(tx, { target, grants, owners, now: deps.clock(), authorise });
      // A change that forgot to re-authorise must not commit.
      if (!authorised) throw new Error(`${what} did not re-authorise the actor`);
      return result;
    }),
  );
}

/** Only an owner manages super managers (design §4.1). */
function requireOwnerFor(target: Pick<Row, 'role'>, actor: Actor): void {
  if (target.role === 'super_manager' && !actor.isOwner) throw ownerRequired();
}

/** The number of active owners other than `exceptId`; zero means removing that one would leave none. */
function otherActiveOwners(owners: OwnerRow[], exceptId: string): number {
  return owners.filter((o) => o.status === 'active' && o.id !== exceptId).length;
}

function assertNotLastOwner(owners: OwnerRow[], target: Row): void {
  if (target.isOwner && target.status === 'active' && otherActiveOwners(owners, target.id) === 0) {
    throw apiError(409, 'last_owner');
  }
}

// --- reads ------------------------------------------------------------------------------------

export type ListFilter = { role?: Role; status?: UserStatus; q?: string; page: number };

/** `%`, `_` and the escape character itself must match literally in a LIKE pattern. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

export async function listUsers(db: Db, filter: ListFilter): Promise<{ items: User[]; total: number }> {
  const conditions: (SQL | undefined)[] = [];
  if (filter.role) conditions.push(eq(users.role, filter.role));
  if (filter.status) conditions.push(eq(users.status, filter.status));
  const term = filter.q?.trim();
  if (term) {
    const pattern = `%${escapeLike(term)}%`;
    conditions.push(or(ilike(users.fullName, pattern), ilike(users.email, pattern), ilike(users.phone, pattern)));
  }
  const where = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), asc(users.id))
      .limit(PAGE_SIZE)
      .offset((filter.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(users).where(where),
  ]);

  const granted = new Map<string, Permission[]>();
  if (rows.length > 0) {
    const grants = await db
      .select()
      .from(userPermissions)
      .where(
        inArray(
          userPermissions.userId,
          rows.map((r) => r.id),
        ),
      );
    for (const g of grants) granted.set(g.userId, [...(granted.get(g.userId) ?? []), g.permission]);
  }
  return {
    items: rows.map((r) => toDto(r, sortGrants(granted.get(r.id) ?? []))),
    total: totalRow?.total ?? 0,
  };
}

export async function getUser(db: Db, id: string): Promise<User> {
  assertId(id);
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw notFound();
  return toDto(row, await loadGrants(db, id));
}

// --- create -----------------------------------------------------------------------------------

/** Tries to mail an invitation; a failure is logged (without the address) and reported, never thrown. */
async function trySendInvite(deps: Deps, log: Log, user: Row): Promise<boolean> {
  try {
    await sendInvite(deps, { id: user.id, email: user.email, fullName: user.fullName, role: user.role });
    return true;
  } catch {
    // The error is dropped on purpose: a mail transport error usually quotes the recipient.
    log.error({ userId: user.id }, 'invitation mail could not be sent');
    return false;
  }
}

export async function createUser(deps: Deps, actor: Actor, input: CreateUserInput, log: Log): Promise<User> {
  if (input.role === 'super_manager' && !actor.isOwner) throw ownerRequired();

  if (input.role !== 'super_manager') {
    const errors: Record<string, string> = {};
    if (input.permissions !== undefined) errors.permissions = 'Les permissions ne concernent que les super managers.';
    if (input.isOwner !== undefined) errors.isOwner = 'Le statut de propriétaire ne concerne que les super managers.';
    if (Object.keys(errors).length > 0) throw validationError(errors);
  }

  const grants = input.role === 'super_manager' ? sortGrants(input.permissions ?? []) : [];
  const now = deps.clock();
  const created = await guarded(log, 'user creation', () =>
    deps.db.transaction(async (tx) => {
      // Same lock order as every other mutation; the creator is re-checked under it.
      const owners = await lockOwners(tx);
      await reauthorise(tx, actor, owners, input.role === 'super_manager');
      const [row] = await tx
        .insert(users)
        .values({
          email: input.email,
          fullName: input.fullName,
          phone: input.phone ?? null,
          role: input.role,
          status: 'invited',
          isOwner: input.isOwner ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      if (grants.length > 0) {
        await tx.insert(userPermissions).values(grants.map((permission) => ({ userId: row.id, permission })));
      }
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'user.created',
        entityType: 'user',
        entityId: row.id,
        after: snapshot(row, grants),
        ip: actor.ip,
        requestId: actor.requestId,
      });
      return row;
    }),
  );

  // After the commit: a mail failure must neither undo the account nor fail the request. The user
  // stays `invited` and the invitation can be re-sent.
  await trySendInvite(deps, log, created);
  return toDto(created, grants);
}

// --- update -----------------------------------------------------------------------------------

export type UpdateInput = UpdateUserInput & { reason?: string };

export async function updateUser(
  deps: Deps,
  actor: Actor,
  id: string,
  input: UpdateInput,
  log: Log,
): Promise<User> {
  return mutate(deps, log, 'user update', actor, id, async (tx, { target, grants, owners, now, authorise }) => {
    const self = target.id === actor.userId;
    const newRole = input.role ?? target.role;
    const roleChanged = newRole !== target.role;
    const newGrants = input.permissions === undefined ? grants : sortGrants(input.permissions);
    const ownerProvided = input.isOwner !== undefined;
    const newOwner = input.isOwner ?? target.isOwner;
    const ownerChanged = newOwner !== target.isOwner;

    // Nobody edits their own authority; this comes before the owner rule so the answer is the same
    // whether or not the caller is an owner.
    const grantsChangedByInput =
      input.permissions !== undefined &&
      (newGrants.length !== grants.length || newGrants.some((p, i) => p !== grants[i]));
    if (self && (roleChanged || grantsChangedByInput)) throw apiError(403, 'forbidden');

    requireOwnerFor(target, actor);
    if (roleChanged && newRole === 'super_manager' && !actor.isOwner) throw ownerRequired();

    // Permissions and the owner flag exist only on super managers.
    const errors: Record<string, string> = {};
    if (newRole !== 'super_manager') {
      if (input.permissions !== undefined) errors.permissions = 'Les permissions ne concernent que les super managers.';
      if (ownerProvided) errors.isOwner = 'Le statut de propriétaire ne concerne que les super managers.';
    }
    if (roleChanged && target.role === 'super_manager' && target.isOwner) {
      errors.role = 'Retirez d’abord le statut de propriétaire.';
    }
    if (Object.keys(errors).length > 0) throw validationError(errors);

    // The role cannot change while the user is an owner (checked above), so the flag is the only
    // way to drop an active owner here; the suspension path has its own check.
    if (ownerChanged && !newOwner) assertNotLastOwner(owners, target);

    // After the last-owner check, so of two owners demoting each other the loser still hears
    // `last_owner`. A change that touches a super manager, or makes one, needs an owner.
    await authorise(target.role === 'super_manager' || newRole === 'super_manager');

    const finalGrants = newRole === 'super_manager' ? newGrants : [];
    const grantsChanged = finalGrants.length !== grants.length || finalGrants.some((p, i) => p !== grants[i]);

    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.fullName !== undefined && input.fullName !== target.fullName) patch.fullName = input.fullName;
    if (input.phone !== undefined && input.phone !== target.phone) patch.phone = input.phone;
    if (roleChanged) patch.role = newRole;
    if (ownerChanged) patch.isOwner = newOwner;

    if (Object.keys(patch).length === 0 && !grantsChanged) return toDto(target, grants);

    const [updated] = await tx
      .update(users)
      .set({ ...patch, updatedAt: now })
      .where(eq(users.id, target.id))
      .returning();
    if (!updated) throw notFound();
    if (grantsChanged) {
      await tx.delete(userPermissions).where(eq(userPermissions.userId, target.id));
      if (finalGrants.length > 0) {
        await tx.insert(userPermissions).values(finalGrants.map((permission) => ({ userId: target.id, permission })));
      }
    }
    // §4.4.5: a change of role, permissions or owner flag takes effect at once, not at next login.
    if (roleChanged || grantsChanged || ownerChanged) await revokeUserSessions(tx, target.id, undefined, now);

    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.updated',
      entityType: 'user',
      entityId: target.id,
      before: snapshot(target, grants),
      after: snapshot(updated, finalGrants),
      reason: input.reason,
      ip: actor.ip,
      requestId: actor.requestId,
    });
    return toDto(updated, finalGrants);
  });
}

// --- status changes ---------------------------------------------------------------------------

type ActionInput = { reason?: string };

export async function suspendUser(
  deps: Deps,
  actor: Actor,
  id: string,
  input: ActionInput,
  log: Log,
): Promise<void> {
  return mutate(deps, log, 'user suspension', actor, id, async (tx, { target, grants, owners, now, authorise }) => {
    if (target.id === actor.userId) throw apiError(409, 'cannot_suspend_self');
    requireOwnerFor(target, actor);
    const needsOwner = target.role === 'super_manager';
    if (target.status === 'suspended' || target.status === 'deactivated') {
      await authorise(needsOwner);
      if (target.status === 'deactivated') throw apiError(409, 'invalid_status');
      return;
    }
    assertNotLastOwner(owners, target);
    await authorise(needsOwner);

    const [updated] = await tx
      .update(users)
      .set({ status: 'suspended', updatedAt: now })
      .where(eq(users.id, target.id))
      .returning();
    if (!updated) throw notFound();
    await revokeUserSessions(tx, target.id, undefined, now);
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.suspended',
      entityType: 'user',
      entityId: target.id,
      before: snapshot(target, grants),
      after: snapshot(updated, grants),
      reason: input.reason,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  });
}

export async function reactivateUser(
  deps: Deps,
  actor: Actor,
  id: string,
  input: ActionInput,
  log: Log,
): Promise<void> {
  return mutate(deps, log, 'user reactivation', actor, id, async (tx, { target, grants, now, authorise }) => {
    requireOwnerFor(target, actor);
    await authorise(target.role === 'super_manager');
    if (target.status !== 'suspended') throw apiError(409, 'not_suspended');

    // Someone who never set a password goes back to waiting for their invitation.
    const status: UserStatus = target.passwordHash === null ? 'invited' : 'active';
    const [updated] = await tx
      .update(users)
      .set({ status, updatedAt: now })
      .where(eq(users.id, target.id))
      .returning();
    if (!updated) throw notFound();
    await revokeUserSessions(tx, target.id, undefined, now);
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.reactivated',
      entityType: 'user',
      entityId: target.id,
      before: snapshot(target, grants),
      after: snapshot(updated, grants),
      reason: input.reason,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  });
}

export async function revokeSessions(
  deps: Deps,
  actor: Actor,
  id: string,
  input: ActionInput,
  log: Log,
): Promise<void> {
  return mutate(deps, log, 'session revocation', actor, id, async (tx, { target, now, authorise }) => {
    requireOwnerFor(target, actor);
    await authorise(target.role === 'super_manager');
    await revokeUserSessions(tx, target.id, undefined, now);
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.sessions_revoked',
      entityType: 'user',
      entityId: target.id,
      reason: input.reason,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  });
}

/**
 * Sends a fresh invitation (older links stop working) to a user who has not accepted one yet. The
 * token and the `user.invite_resent` audit row commit together, under the same locks and
 * re-authorisation as every other change; the mail goes out AFTER the commit. Returns false when
 * the transport fails: the new token and the audit row stay (the link was issued but not
 * delivered), and the next resend replaces that token.
 */
export async function resendInvite(
  deps: Deps,
  actor: Actor,
  id: string,
  input: ActionInput,
  log: Log,
): Promise<boolean> {
  const mail = await mutate(deps, log, 'invitation', actor, id, async (tx, { target, authorise }) => {
    requireOwnerFor(target, actor);
    await authorise(target.role === 'super_manager');
    if (target.status !== 'invited') throw apiError(409, 'not_invited');

    const issued = await issueInviteMail(deps, tx, target);
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'user.invite_resent',
      entityType: 'user',
      entityId: target.id,
      reason: input.reason,
      ip: actor.ip,
      requestId: actor.requestId,
    });
    return issued;
  });

  try {
    await deps.mailer.send(mail);
    return true;
  } catch {
    // The error is dropped on purpose: a mail transport error usually quotes the recipient.
    log.error({ userId: id }, 'invitation mail could not be sent');
    return false;
  }
}

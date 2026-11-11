import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { emailSchema, ROLE_LABELS } from '@/shared';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Db } from '../db/sqlite';
import { recordAudit } from '../audit';
import { issueToken, linkFor } from '../auth/tokens';
import { newId } from '../ids';
import type { Mail } from '../mail/mailer';
import { inviteMail } from '../mail/templates';
import { HttpFailure, isUniqueViolation, notFound } from './errors';

// The first owner. Two ways in, both single immediate transactions:
//  - the CLI (`npm run create-owner`): an INVITED owner and an invitation link;
//  - the one-time setup page (`/configuration`, POST /api/setup): an ACTIVE owner with a password, possible only
//    while the users table is empty AND the SETUP_TOKEN environment variable is set.

export const SETUP_AUDIT_REASON = 'first-run setup';
export const CLI_AUDIT_REASON = 'cli create-owner';

const OWNER_SNAPSHOT = (email: string, fullName: string, status: 'active' | 'invited') => ({
  fullName,
  email,
  phone: null,
  role: 'super_manager',
  status,
  isOwner: true,
  permissions: [],
});

// --- setup page -------------------------------------------------------------------------------------

/** The setup page and route exist only while no user exists and a setup token is configured. */
export function setupAvailable(deps: { db: Db; config: Pick<Config, 'setupToken'> }): boolean {
  if (!deps.config.setupToken) return false;
  return deps.db.get('SELECT 1 AS any_user FROM users LIMIT 1') === undefined;
}

/** Constant-time comparison: both sides are hashed first so the lengths are equal and the comparison cannot leak them. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Creates the first owner, active, with an already hashed password. The emptiness of the users table is checked
 * again INSIDE the immediate transaction, so of any number of simultaneous setups exactly one wins and the others
 * get 404 (the page is closed for good once a user exists).
 */
export function setupFirstOwner(
  deps: { db: Db; clock: Clock },
  p: { email: string; fullName: string; passwordHash: string; ip: string; requestId: string },
): { userId: string } {
  const email = p.email.trim().toLowerCase();
  try {
    return deps.db.transaction((tx) => {
      if (tx.get('SELECT 1 AS any_user FROM users LIMIT 1')) throw notFound();
      const now = deps.clock.now();
      const id = newId(deps.clock);
      tx.run(
        `INSERT INTO users (id, email, password_hash, full_name, role, status, is_owner, created_at, updated_at)
         VALUES (:id, :email, :hash, :name, 'super_manager', 'active', 1, :now, :now)`,
        { id, email, hash: p.passwordHash, name: p.fullName, now },
      );
      recordAudit(tx, {
        actorUserId: null,
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        after: OWNER_SNAPSHOT(email, p.fullName, 'active'),
        reason: SETUP_AUDIT_REASON,
        ip: p.ip,
        requestId: p.requestId,
        at: now,
      });
      return { userId: id };
    }, 'immediate');
  } catch (err) {
    if (isUniqueViolation(err, 'users.email')) throw new HttpFailure(409, 'email_taken');
    throw err;
  }
}

// --- CLI --------------------------------------------------------------------------------------------

export type CreateOwnerErrorCode = 'owner_exists' | 'email_taken' | 'invalid_args';

/** A refusal with a stable `code`; its message is safe to print (it never carries the address or a secret). */
export class CreateOwnerError extends Error {
  constructor(
    readonly code: CreateOwnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreateOwnerError';
  }
}

const argsSchema = z.object({ email: emailSchema, fullName: z.string().trim().min(2).max(120) });

/**
 * Creates an `invited` owner (no password), an invitation token and the audit row (actor null) in one immediate
 * transaction. Refuses when any owner row exists, whatever its status, unless `force`, and when the e-mail
 * address is in use (never forced). Returns the link and the invitation mail so the caller can try to send it.
 */
export function createInvitedOwner(
  deps: { db: Db; clock: Clock; config: Pick<Config, 'appOrigin'> },
  args: { email: string; fullName: string; force: boolean },
): { userId: string; link: string; mail: Mail } {
  const parsed = argsSchema.safeParse({ email: args.email, fullName: args.fullName });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => (issue.path[0] === 'fullName' ? 'name' : String(issue.path[0]))))];
    throw new CreateOwnerError('invalid_args', `Invalid ${fields.join(' and ')}.`);
  }
  const { email, fullName } = parsed.data;
  try {
    return deps.db.transaction((tx) => {
      if (!args.force && tx.get('SELECT 1 AS owner FROM users WHERE is_owner = 1 LIMIT 1')) {
        throw new CreateOwnerError('owner_exists', 'An owner account already exists. Pass --force to create another.');
      }
      if (tx.get('SELECT 1 AS taken FROM users WHERE email = ?', email)) {
        throw new CreateOwnerError('email_taken', 'An account with this e-mail address already exists.');
      }
      const now = deps.clock.now();
      const id = newId(deps.clock);
      tx.run(
        `INSERT INTO users (id, email, full_name, role, status, is_owner, created_at, updated_at)
         VALUES (:id, :email, :name, 'super_manager', 'invited', 1, :now, :now)`,
        { id, email, name: fullName, now },
      );
      recordAudit(tx, {
        actorUserId: null,
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        after: OWNER_SNAPSHOT(email, fullName, 'invited'),
        reason: CLI_AUDIT_REASON,
        at: now,
      });
      const token = issueToken(tx, deps.clock, { userId: id, type: 'invite' });
      const link = linkFor(deps.config, '/invitation', token);
      return { userId: id, link, mail: { to: email, ...inviteMail({ fullName, link, roleLabel: ROLE_LABELS.super_manager }) } };
    }, 'immediate');
  } catch (err) {
    if (isUniqueViolation(err, 'users.email')) throw new CreateOwnerError('email_taken', 'An account with this e-mail address already exists.');
    throw err;
  }
}

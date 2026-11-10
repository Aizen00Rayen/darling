import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { emailSchema, ROLE_LABELS } from '@darling/shared';
import type { Config } from '../config';
import { loadConfig } from '../config';
import { createDb, type Db } from '../db/client';
import { users } from '../db/schema';
import { systemClock, type Clock } from '../lib/clock';
import { smtpMailer, type Mailer } from '../mail/mailer';
import { inviteMail } from '../mail/templates';
import { recordAudit } from '../modules/audit/service';
import { INVITE_TTL_MS, issueToken, linkFor } from '../modules/auth/tokens';

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

export type CreateOwnerDeps = {
  db: Db;
  mailer: Mailer;
  config: Pick<Config, 'appOrigin'>;
  clock: Clock;
  /** Receives a short, address-free warning when the mail could not be sent. */
  warn?: (message: string) => void;
};
export type CreateOwnerArgs = { email: string; name: string; force: boolean };

const argsSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(120),
});

const AUDIT_REASON = 'cli create-owner';
const USAGE = 'Usage: pnpm --filter @darling/api create-owner --email <email> --name "<full name>" [--force]';

function isEmailConflict(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === '23505' && typeof constraint === 'string' && constraint.includes('email')) return true;
    current = cause;
  }
  return false;
}

/**
 * Creates the first owner: an `invited` Super Manager with the owner flag and no password, plus an
 * invitation token. Refuses when any owner row exists (whatever its status) unless `force`, and when
 * the e-mail address is already in use. The invitation is mailed after the commit; a mail failure
 * only produces a warning, because the returned link is what the operator really needs.
 */
export async function createOwner(deps: CreateOwnerDeps, args: CreateOwnerArgs): Promise<{ link: string }> {
  const parsed = argsSchema.safeParse({ email: args.email, name: args.name });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new CreateOwnerError('invalid_args', `Invalid ${fields.join(' and ')}.`);
  }
  const { email, name } = parsed.data;
  const now = deps.clock();

  let created: { id: string; token: string };
  try {
    created = await deps.db.transaction(async (tx) => {
      // With no owner yet there is no row to lock, so two simultaneous runs are ordered here.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cli:create-owner'))`);
      if (!args.force) {
        const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.isOwner, true)).limit(1);
        if (owner) {
          throw new CreateOwnerError('owner_exists', 'An owner account already exists. Pass --force to create another.');
        }
      }
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (taken) throw new CreateOwnerError('email_taken', 'An account with this e-mail address already exists.');

      const [row] = await tx
        .insert(users)
        .values({
          email,
          fullName: name,
          role: 'super_manager',
          status: 'invited',
          isOwner: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      await recordAudit(tx, {
        actorUserId: null,
        action: 'user.created',
        entityType: 'user',
        entityId: row.id,
        after: {
          fullName: row.fullName,
          email: row.email,
          phone: row.phone,
          role: row.role,
          status: row.status,
          isOwner: row.isOwner,
          permissions: [],
        },
        reason: AUDIT_REASON,
      });
      const token = await issueToken(tx, { userId: row.id, type: 'invite', now });
      return { id: row.id, token };
    });
  } catch (err) {
    // A concurrent run with the same address can still lose at the unique index.
    if (isEmailConflict(err)) throw new CreateOwnerError('email_taken', 'An account with this e-mail address already exists.');
    throw err;
  }

  const link = linkFor(deps, '/invitation', created.token);
  try {
    const mail = inviteMail({ fullName: name, link, roleLabel: ROLE_LABELS.super_manager });
    await deps.mailer.send({ to: email, ...mail });
  } catch {
    // Dropped on purpose: a transport error usually quotes the recipient.
    deps.warn?.('Warning: the invitation e-mail could not be sent. Give the link above to the owner yourself.');
  }
  return { link };
}

export type MainIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Replaces the SMTP transport (tests). */
  mailer?: Mailer;
  clock?: Clock;
};

const processIo: MainIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** The command: parses `argv`, runs it against the configured database and returns the exit code. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: MainIo = processIo,
): Promise<number> {
  const fail = (message: string, withUsage = false): number => {
    io.stderr(`${message}\n${withUsage ? `${USAGE}\n` : ''}`);
    return 1;
  };

  let values: { email?: string | undefined; name?: string | undefined; force?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return fail(`Error: ${err instanceof Error ? err.message : 'invalid arguments'}`, true);
  }
  if (values.email === undefined || values.name === undefined) {
    return fail('Error: --email and --name are required.', true);
  }
  const args: CreateOwnerArgs = { email: values.email, name: values.name, force: values.force === true };

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    // Config errors list key names only, never values.
    return fail(err instanceof Error ? err.message : 'Invalid configuration.');
  }

  // The application role (DATABASE_URL), like the API itself; never the owner role.
  const { db, close } = createDb(config.databaseUrl);
  try {
    const { link } = await createOwner(
      {
        db,
        mailer: io.mailer ?? smtpMailer(config.smtpUrl, config.mailFrom),
        config,
        clock: io.clock ?? systemClock,
        warn: (message) => io.stderr(`${message}\n`),
      },
      args,
    );
    const days = Math.round(INVITE_TTL_MS / 86_400_000);
    io.stdout(`Owner account created. Invitation link (valid ${days} days):\n${link}\n`);
    return 0;
  } catch (err) {
    if (err instanceof CreateOwnerError) return fail(`Error: ${err.message}`, err.code === 'invalid_args');
    // Never print the error object: it can quote connection details.
    const pgCode = (err as { code?: unknown } | null)?.code;
    return fail(`Error: create-owner failed${typeof pgCode === 'string' ? ` (${pgCode})` : ''}.`);
  } finally {
    await close().catch(() => {});
  }
}

function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  // Resolve relative to this file, not the cwd, so `pnpm --filter` and root runs agree.
  dotenv.config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });
  process.exitCode = await main(process.argv.slice(2), process.env);
}

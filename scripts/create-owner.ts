import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInvitedOwner, CreateOwnerError } from '../server/admin/first-owner';
import { systemClock, type Clock } from '../server/clock';
import { loadConfig, type Config } from '../server/config';
import { buildMailer } from '../server/context';
import { getDb } from '../server/db';
import type { Db } from '../server/db/sqlite';
import { INVITE_TTL_MS } from '../server/auth/tokens';
import type { Mailer } from '../server/mail/mailer';

// First-owner command:  npm run create-owner -- --email owner@example.com --name "Full Name" [--force]
// Creates an INVITED owner (no password), prints the invitation link and tries to mail it. Refuses when an owner
// already exists (unless --force) or the e-mail address is taken. Prefer the /configuration page when there is no
// terminal (see README); both end the same way: an owner who logs in and enrols 2FA.

const USAGE = 'Usage: npm run create-owner -- --email <email> --name "<full name>" [--force]';

export interface MainIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Replaces the database, mailer and clock (tests). */
  deps?: { db: Db; mailer: Mailer; clock?: Clock };
}

const processIo: MainIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** Parses `argv`, runs the command against the configured database and returns the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: MainIo = processIo): Promise<number> {
  const fail = (message: string, withUsage = false): number => {
    io.stderr(`${message}\n${withUsage ? `${USAGE}\n` : ''}`);
    return 1;
  };

  let values: { email?: string | undefined; name?: string | undefined; force?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { email: { type: 'string' }, name: { type: 'string' }, force: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return fail(`Error: ${err instanceof Error ? err.message : 'invalid arguments'}`, true);
  }
  if (values.email === undefined || values.name === undefined) return fail('Error: --email and --name are required.', true);

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    // Config errors list key names only, never values.
    return fail(err instanceof Error ? err.message : 'Invalid configuration.');
  }

  try {
    const clock = io.deps?.clock ?? systemClock;
    const db = io.deps?.db ?? getDb();
    const mailer = io.deps?.mailer ?? buildMailer(config);
    const { link, mail } = createInvitedOwner({ db, clock, config }, { email: values.email, fullName: values.name, force: values.force === true });
    const days = Math.round(INVITE_TTL_MS / 86_400_000);
    io.stdout(`Owner account created. Invitation link (valid ${days} days):\n${link}\n`);
    try {
      await mailer.send(mail);
    } catch {
      // Dropped on purpose: a transport error usually quotes the recipient.
      io.stderr('Warning: the invitation e-mail could not be sent. Give the link above to the owner yourself.\n');
    }
    return 0;
  } catch (err) {
    if (err instanceof CreateOwnerError) return fail(`Error: ${err.message}`, err.code === 'invalid_args');
    // Never print the error object: it can quote connection details.
    return fail('Error: create-owner failed.');
  }
}

/** True only when this file is the script being run (not when a test imports it). Works for CJS (tsx) and ESM. */
function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return /[\\/]scripts[\\/]create-owner\.[cm]?[jt]s$/.test(realpathSync(entry));
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}

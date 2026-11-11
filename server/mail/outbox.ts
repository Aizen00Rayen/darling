import { log } from '../log';
import type { Mail, Mailer } from './mailer';

// Best-effort, fire-and-forget background work started AFTER a response is built: mail delivery and the
// account lookup of "forgot password". Nothing here is awaited by a request. Failures are logged as
// { kind of error, code } only: error messages from SMTP servers contain addresses, so they never reach the log.

const pending = new Set<Promise<void>>();

function describe(err: unknown): { errName: string; errCode?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return { errName: err instanceof Error ? err.name : 'unknown', ...(typeof code === 'string' ? { errCode: code } : {}) };
}

/** Runs `work` on a later turn of the event loop (after the current response has been built). */
export function runInBackground(event: string, work: () => void | Promise<void>): void {
  const task: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(work)
    .catch((err: unknown) => log.error(event, describe(err)))
    .finally(() => pending.delete(task));
  pending.add(task);
}

export function sendMailInBackground(mailer: Mailer, mail: Mail, event = 'mail.send_failed'): void {
  runInBackground(event, () => mailer.send(mail));
}

/** Resolves once every background task started so far has finished. Tests and graceful shutdown use it. */
export async function settleBackgroundWork(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

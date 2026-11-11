import { loadConfig, type Config } from './config';
import { getDb } from './db';
import { parseSmtpUrl } from './mail/mailer';
import { settleBackgroundWork } from './mail/outbox';

// Fail-fast startup checks and graceful drain. Server-only; called from instrumentation.ts on the Node.js runtime.

/**
 * Validates the whole configuration, parses the SMTP URL and opens the database (applying pending migrations),
 * so a bad production configuration or an unwritable DATA_DIR stops the server at start instead of failing every
 * request. Throws on the first problem; never logs values.
 */
export function runStartupChecks(env: Record<string, string | undefined> = process.env): { config: Config } {
  const config = loadConfig(env);
  if (config.smtpUrl) parseSmtpUrl(config.smtpUrl);
  getDb();
  return { config };
}

/** Waits for background work (mail still being sent) to finish, but never longer than `capMs`. */
export async function drainBackgroundWork(capMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
    timer.unref?.();
  });
  try {
    await Promise.race([settleBackgroundWork(), cap]);
  } finally {
    clearTimeout(timer);
  }
}

const SHUTDOWN_CAP_MS = 5_000;

/**
 * Best effort: on SIGTERM/SIGINT start draining pending background mail (5 s cap). The handler does not exit the
 * process itself (Next's own shutdown handling does); it only gives in-flight mail a chance to finish.
 */
export function installShutdownDrain(
  proc: { once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown } = process,
  drain: (capMs: number) => Promise<void> = drainBackgroundWork,
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.once(signal, () => void drain(SHUTDOWN_CAP_MS));
  }
}

import { loadConfig, type Config } from './config';
import { systemClock, type Clock } from './clock';
import { getDb } from './db';
import type { Db } from './db/sqlite';
import { consoleMailer, smtpMailer, type LogFn, type Mailer } from './mail/mailer';
import { createRateLimiter, type RateLimiter } from './security/rate-limit';

// Everything a route handler needs, built once per process from the environment. Server-only.

export interface ServerContext {
  db: Db;
  clock: Clock;
  config: Config;
  mailer: Mailer;
  /** In-memory rate limits (one process). Part of the context so tests get their own. */
  limiter: RateLimiter;
}

const DEFAULT_MAIL_FROM = 'DARLING* <no-reply@darling7.store>';

export function buildMailer(config: Pick<Config, 'nodeEnv' | 'smtpUrl' | 'mailFrom'>, logFn?: LogFn): Mailer {
  if (config.smtpUrl) return smtpMailer(config.smtpUrl, config.mailFrom ?? DEFAULT_MAIL_FROM);
  // No SMTP configured. Development: the link is written to the log (never in production: it is a credential).
  if (config.nodeEnv !== 'production') return consoleMailer(logFn);
  return {
    async send() {
      throw new Error('SMTP_URL is not configured: mail cannot be sent');
    },
  };
}

const KEY = Symbol.for('darling.serverContext');
interface Holder {
  ctx?: ServerContext;
  override?: ServerContext | null;
}
function holder(): Holder {
  // On globalThis so every Next.js bundle (route handlers, server components) and dev reloads share one context.
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  return (g[KEY] ??= {});
}

function build(): ServerContext {
  const config = loadConfig(process.env);
  return {
    // Opened (and migrated) on first use, so a route that never touches the database never opens it.
    get db() {
      return getDb();
    },
    clock: systemClock,
    config,
    mailer: buildMailer(config),
    limiter: createRateLimiter(systemClock),
  };
}

export function getServerContext(): ServerContext {
  const h = holder();
  if (h.override) return h.override;
  return (h.ctx ??= build());
}

/** Tests: make getServerContext() return this context (null restores the real one). */
export function setServerContextForTests(ctx: ServerContext | null): void {
  holder().override = ctx;
}

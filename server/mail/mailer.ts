import nodemailer from 'nodemailer';
import { log } from '../log';

export type Mail = { to: string; subject: string; text: string; html: string };
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS (`smtps://`). */
  secure: boolean;
  /** STARTTLS is mandatory: the connection fails rather than send in clear text. */
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 } as const;

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * `smtp://[user:pass@]host[:port][?starttls=optional|required]` or `smtps://...` (implicit TLS, port 465).
 * STARTTLS is opportunistic for loopback hosts (local Mailpit) and REQUIRED for every other host unless
 * the URL says `starttls=optional`. Credentials are percent-decoded. Errors never echo the URL.
 */
export function parseSmtpUrl(raw: string): SmtpOptions {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SMTP_URL is not a valid URL');
  }
  if ((url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname) {
    throw new Error('SMTP_URL must look like smtp://host[:port] or smtps://host[:port]');
  }
  const secure = url.protocol === 'smtps:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const mode = url.searchParams.get('starttls');
  if (mode !== null && mode !== 'optional' && mode !== 'required') {
    throw new Error('SMTP_URL: starttls must be "optional" or "required"');
  }
  const requireTLS = secure ? false : mode === 'required' ? true : mode === 'optional' ? false : !isLoopback(host);
  const options: SmtpOptions = {
    host,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS,
    ...TIMEOUTS,
  };
  if (url.username || url.password) {
    try {
      options.auth = { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
    } catch {
      throw new Error('SMTP_URL has badly encoded credentials');
    }
  }
  return options;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(parseSmtpUrl(url));
  return {
    async send(mail) {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    },
  };
}

export type MemoryMailer = Mailer & { sent: Mail[] };

/** Records mails instead of sending them; used by the tests. */
export function memoryMailer(): MemoryMailer {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

export type LogFn = (level: 'info', event: string, fields: Record<string, unknown>) => void;

/**
 * Development without SMTP_URL: writes the link of the mail (never the address) to the log so the flow can be
 * followed by hand. Only ever built when NODE_ENV is not production (see context.ts).
 */
export function consoleMailer(logFn: LogFn = (_l, event, fields) => log.info(event, fields)): Mailer {
  return {
    async send(mail) {
      const link = /https?:\/\/[^\s<>"]+/.exec(mail.text)?.[0] ?? null;
      logFn('info', 'mail.dev_not_sent', { subject: mail.subject, link });
    },
  };
}

import nodemailer from 'nodemailer';

export type Mail = { to: string; subject: string; text: string; html: string };
export type Mailer = { send(mail: Mail): Promise<void> };

export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
};

/**
 * `smtp://[user:pass@]host[:port]` (STARTTLS used when the server offers it; plain for local
 * Mailpit) or `smtps://...` (implicit TLS). Credentials are percent-decoded.
 */
export function parseSmtpUrl(url: string): SmtpOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SMTP_URL is not a valid URL');
  }
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    throw new Error('SMTP_URL must start with smtp:// or smtps://');
  }
  const secure = parsed.protocol === 'smtps:';
  const options: SmtpOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : secure ? 465 : 587,
    secure,
  };
  if (parsed.username || parsed.password) {
    options.auth = {
      user: decodeURIComponent(parsed.username),
      pass: decodeURIComponent(parsed.password),
    };
  }
  return options;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(parseSmtpUrl(url));
  return {
    async send(mail) {
      await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
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

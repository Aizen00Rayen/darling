import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Mail, Mailer } from './mailer';

// Development/test mail outbox: every outgoing mail is also written as a JSON file so an end-to-end test can
// read the invitation and reset links. It stores one-time links in clear text, so config.ts refuses
// MAIL_OUTBOX_DIR in production and buildMailer (context.ts) refuses it again.

export interface OutboxEntry {
  to: string;
  subject: string;
  text: string;
  links: string[];
  at: number;
}

const URL_RE = /https?:\/\/[^\s<>"]+/g;

/** Links of a mail body; trailing sentence punctuation is not part of the link. */
function linksOf(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((l) => l.replace(/[.,;:!?)]+$/, ''));
}

export function fileOutboxMailer(dir: string, inner?: Mailer, now: () => number = Date.now): Mailer {
  let seq = 0;
  return {
    async send(mail: Mail) {
      fs.mkdirSync(dir, { recursive: true });
      const at = now();
      const entry: OutboxEntry = { to: mail.to, subject: mail.subject, text: mail.text, links: linksOf(mail.text), at };
      // Sortable name (time, then a per-process counter), unique across processes thanks to the random suffix.
      seq += 1;
      const name = `${String(at).padStart(15, '0')}-${String(seq).padStart(6, '0')}-${randomBytes(4).toString('hex')}.json`;
      const tmp = path.join(dir, `${name}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, path.join(dir, name)); // never a half-written .json
      if (inner) await inner.send(mail);
    },
  };
}

/** Entries in the order they were sent. Missing directory, foreign or unreadable files: ignored. */
export function readOutbox(dir: string): OutboxEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: OutboxEntry[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as OutboxEntry);
    } catch {
      /* skip */
    }
  }
  return out;
}

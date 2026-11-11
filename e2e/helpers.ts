import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';
import * as OTPAuth from 'otpauth';

export const RUN_DIR = process.env.E2E_RUN_DIR as string;
export const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN as string;
export const MAIL_DIR = path.join(RUN_DIR, 'mail');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
export const SESSIONS_DIR = path.join(RUN_DIR, 'sessions');

/** Facts the serial scenarios hand to each other. Stored in a file so a restarted worker still sees them. */
export interface SharedState {
  owner?: { email: string; password: string; name: string; totpSecret: string };
  manager?: { email: string; password: string; name: string };
  affiliate?: { email: string; password: string; name: string; phone: string; code: string };
  order?: { number: string; customerPhone: string };
}

export function readState(): SharedState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SharedState;
  } catch {
    return {};
  }
}
export function writeState(patch: SharedState): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}

/** A clear failure when a scenario runs without the ones it depends on (e.g. `--grep` of a single test). */
export function need<K extends keyof SharedState>(key: K, because: string): NonNullable<SharedState[K]> {
  const value = readState()[key];
  if (!value) {
    throw new Error(
      `This scenario depends on state created by an earlier one (missing "${key}": ${because}). ` +
        'The scenarios in e2e/launch.spec.ts are serial and build on each other: run the whole file, not a single test.',
    );
  }
  return value as NonNullable<SharedState[K]>;
}

let ipSeq = 0;
/** A distinct client address per browser context (TRUSTED_PROXY_HOPS=1 reads the right-most X-Forwarded-For entry). */
export function freshIp(): string {
  ipSeq += 1;
  return `203.0.113.${(ipSeq % 250) + 1}`;
}

export async function newContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const headers = { 'X-Forwarded-For': freshIp(), ...(options.extraHTTPHeaders ?? {}) };
  return browser.newContext({ ...options, extraHTTPHeaders: headers });
}

export function sessionFile(name: string): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return path.join(SESSIONS_DIR, `${name}.json`);
}

/** The 6-digit code for a base32 secret at `stepOffset` 30-second steps from now. */
export function totpCode(secret: string, stepOffset = 0): string {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret.replace(/\s/g, '')) }).generate({
    timestamp: Date.now() + stepOffset * 30_000,
  });
}

interface OutboxMail {
  to: string;
  subject: string;
  text: string;
  links: string[];
}
export function readOutbox(): OutboxMail[] {
  let names: string[];
  try {
    names = fs.readdirSync(MAIL_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.map((n) => JSON.parse(fs.readFileSync(path.join(MAIL_DIR, n), 'utf8')) as OutboxMail);
}

/** The newest link of the form `<origin>/<path>?token=...` mailed to `email` (or undefined yet). */
export function linkMailedTo(email: string, pathPrefix: string): string | undefined {
  const mails = readOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase());
  for (const mail of mails.reverse()) {
    const link = mail.links.find((l) => new URL(l).pathname === pathPrefix);
    if (link) return link;
  }
  return undefined;
}

/** A password that satisfies the policy and is unique to this run. */
export function strongPassword(label: string): string {
  return `E2e-${label}-${Math.random().toString(36).slice(2, 10)}-Gloss!`;
}

/** Non-breaking and narrow spaces in amounts such as `3 000 DA`: accept all of them. */
export const SP = '[\\s\\u00a0\\u202f]';
export function money(amount: number): RegExp {
  const digits = String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, `${SP}?`);
  return new RegExp(`${digits}${SP}*DA`);
}

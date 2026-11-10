import fs from 'node:fs';
import path from 'node:path';
import { expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { MAILPIT_URL, TMP_DIR, WEB_ORIGIN } from './env';
import { BOOTSTRAP_FILE } from './global-setup';

// ---------------------------------------------------------------------------------------------
// Small state files under e2e/.tmp (git-ignored, removed by globalTeardown)
// ---------------------------------------------------------------------------------------------

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

export type Bootstrap = { email: string; name: string; invitationUrl: string };
export const bootstrap = (): Bootstrap => {
  const value = readJson<Bootstrap>(BOOTSTRAP_FILE);
  if (!value) throw new Error('e2e/.tmp/bootstrap.json is missing: globalSetup did not run');
  return value;
};

/** The owner after test 1 enrolled 2FA. Later tests that need an owner depend on it (see ownerApi). */
export type OwnerState = { email: string; password: string; totpSecret: string };
const OWNER_FILE = path.join(TMP_DIR, 'owner.json');
const OWNER_STORAGE_FILE = path.join(TMP_DIR, 'owner-storage.json');
const TOTP_STEP_FILE = path.join(TMP_DIR, 'totp-steps.json');
const LOGIN_WINDOW_FILE = path.join(TMP_DIR, 'login-window.json');

export const saveOwner = (owner: OwnerState): void => writeJson(OWNER_FILE, owner);
export const loadOwner = (): OwnerState | null => readJson<OwnerState>(OWNER_FILE);

// ---------------------------------------------------------------------------------------------
// Unique data
// ---------------------------------------------------------------------------------------------

let counter = 0;
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter}@e2e.darling.test`;
}

/** Long enough for the password policy; unique per call so a stale value can never pass by luck. */
export function newPassword(label: string): string {
  return `E2e-${label}-${Math.random().toString(36).slice(2, 10)}-Pw1!`;
}

// ---------------------------------------------------------------------------------------------
// Mailpit
// ---------------------------------------------------------------------------------------------

type MailSummary = { ID: string; Subject: string; To: { Address: string }[]; Created: string };
type MailDetail = { Text: string; HTML: string };

async function mailpit<T>(urlPath: string): Promise<T> {
  const res = await fetch(`${MAILPIT_URL}${urlPath}`);
  if (!res.ok) throw new Error(`Mailpit ${urlPath} answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Waits for a mail to `address` whose text holds a link to `linkPath` ("/invitation", "/reinitialiser")
 * and returns that link. The newest matching mail wins, so a reset mail is never confused with an
 * earlier invitation to the same address.
 */
export async function waitForLink(address: string, linkPath: '/invitation' | '/reinitialiser'): Promise<string> {
  const pattern = new RegExp(`${WEB_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${linkPath}\\?token=[A-Za-z0-9_-]+`);
  let link = '';
  await expect
    .poll(
      async () => {
        const { messages } = await mailpit<{ messages: MailSummary[] }>('/api/v1/messages?limit=200');
        const mine = messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()));
        for (const message of mine) {
          const detail = await mailpit<MailDetail>(`/api/v1/message/${message.ID}`);
          const found = detail.Text.match(pattern)?.[0];
          if (found) {
            link = found;
            return true;
          }
        }
        return false;
      },
      { message: `no ${linkPath} mail for ${address}`, timeout: 20_000 },
    )
    .toBe(true);
  return link;
}

// ---------------------------------------------------------------------------------------------
// TOTP (SHA-1, 6 digits, 30 s)
// ---------------------------------------------------------------------------------------------

const STEP_MS = 30_000;

/**
 * A code for `secret` that has not been used yet. The API refuses a step that is not newer than the
 * last one used (enable or login), so when this secret already spent the current step the call
 * waits for the next one. That wait (at most 30 s) is the one deliberate delay in the suite.
 */
export async function freshTotpCode(secret: string): Promise<string> {
  const steps = readJson<Record<string, number>>(TOTP_STEP_FILE) ?? {};
  const last = steps[secret] ?? 0;
  let step = Math.floor(Date.now() / STEP_MS);
  if (step <= last) {
    await new Promise((resolve) => setTimeout(resolve, (last + 1) * STEP_MS - Date.now() + 250));
    step = Math.floor(Date.now() / STEP_MS);
  }
  steps[secret] = step;
  writeJson(TOTP_STEP_FILE, steps);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
  return totp.generate({ timestamp: step * STEP_MS });
}

// ---------------------------------------------------------------------------------------------
// Login throttle: the API allows 5 login requests per minute per IP, and every test runs from the
// same IP. Each login goes through `reserveLogins`, which waits for the fixed window to pass when
// the budget is spent, so no test depends on how fast the previous ones ran.
// ---------------------------------------------------------------------------------------------

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000 + 2_000; // the window plus a safety margin for clock skew and latency

type LoginWindow = { start: number; used: number };

async function waitUntil(time: number): Promise<void> {
  const delay = time - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function reserveLogins(count: number): Promise<void> {
  let window = readJson<LoginWindow>(LOGIN_WINDOW_FILE) ?? { start: 0, used: 0 };
  if (window.start > 0 && Date.now() >= window.start + LOGIN_WINDOW_MS) window = { start: 0, used: 0 };
  if (window.start > 0 && window.used + count > LOGIN_LIMIT) {
    await waitUntil(window.start + LOGIN_WINDOW_MS);
    window = { start: 0, used: 0 };
  }
  if (window.start === 0) window.start = Date.now();
  window.used += count;
  writeJson(LOGIN_WINDOW_FILE, window);
}

/**
 * Marks the current window as fully spent, for the one test that deliberately exceeds the limit;
 * whatever logs in afterwards waits for the window to pass.
 */
export async function spendLoginWindow(): Promise<void> {
  const window = readJson<LoginWindow>(LOGIN_WINDOW_FILE);
  writeJson(LOGIN_WINDOW_FILE, { start: window && window.start > 0 ? window.start : Date.now(), used: LOGIN_LIMIT + 1 } satisfies LoginWindow);
}

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

/**
 * Waits until React has hydrated the page around `locator`. A page loaded with `goto` is
 * interactive only after hydration; a click or a fill before that is silently lost.
 */
export async function hydrated(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps'))))
    .toBe(true);
}

export async function setPassword(page: Page, password: string, submit: 'Activer mon compte' | 'Mettre à jour'): Promise<void> {
  const button = page.getByRole('button', { name: submit });
  await hydrated(button);
  await page.getByLabel('Nouveau mot de passe').fill(password);
  await page.getByLabel('Confirmer le mot de passe').fill(password);
  await button.click();
}

/** Fills and submits the /connexion form. `reserve` is false for tests that count attempts themselves. */
export async function submitLogin(page: Page, email: string, password: string, reserve = true): Promise<void> {
  const button = page.getByRole('button', { name: 'Se connecter' });
  await hydrated(button);
  await page.getByLabel('Adresse e-mail').filter({ visible: true }).fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).filter({ visible: true }).fill(password);
  if (reserve) await reserveLogins(1);
  await button.click();
}

/** Logs in through the UI and waits for the portal `home` (or the 2FA step when `totpSecret` is given). */
export async function loginViaUi(page: Page, email: string, password: string, home: string | RegExp, totpSecret?: string): Promise<void> {
  await page.goto('/connexion');
  if (totpSecret) {
    const button = page.getByRole('button', { name: 'Se connecter' });
    await hydrated(button);
    await page.getByLabel('Adresse e-mail').filter({ visible: true }).fill(email);
    await page.getByLabel('Mot de passe', { exact: true }).filter({ visible: true }).fill(password);
    await reserveLogins(2); // the credentials step and the code step are two login requests
    await button.click();
    await page.getByLabel('Code de vérification').fill(await freshTotpCode(totpSecret));
    await page.getByRole('button', { name: 'Valider' }).click();
  } else {
    await submitLogin(page, email, password);
  }
  await expect(page).toHaveURL(home);
}

// ---------------------------------------------------------------------------------------------
// API helpers (the owner's session, used to create fixtures quickly)
// ---------------------------------------------------------------------------------------------

const API_HEADERS = { 'X-Requested-With': 'fetch', Origin: WEB_ORIGIN, Accept: 'application/json' };

export function newApi(storageState?: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: WEB_ORIGIN, extraHTTPHeaders: API_HEADERS, storageState });
}

/** Saves the owner's browser session at the end of test 1 so later tests need no second 2FA login. */
export async function saveOwnerSession(context: BrowserContext): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  await context.storageState({ path: OWNER_STORAGE_FILE });
}

let cachedOwnerApi: APIRequestContext | undefined;

/**
 * An API context signed in as the owner. Depends on test 1 (the owner is created there and its
 * 2FA secret saved). It reuses the session test 1 left behind and falls back to a fresh login
 * with a TOTP code when that session is gone.
 */
export async function ownerApi(): Promise<APIRequestContext> {
  if (cachedOwnerApi) return cachedOwnerApi;
  const owner = loadOwner();
  if (!owner) throw new Error('The owner is enrolled by the first test: run the whole file, in order');
  if (fs.existsSync(OWNER_STORAGE_FILE)) {
    const api = await newApi(OWNER_STORAGE_FILE);
    if ((await api.get('/api/auth/me')).ok()) return (cachedOwnerApi = api);
    await api.dispose();
  }
  const api = await newApi();
  await reserveLogins(1);
  const login = await api.post('/api/auth/login', {
    data: { email: owner.email, password: owner.password, totpCode: await freshTotpCode(owner.totpSecret) },
  });
  expect(login.ok(), 'owner login').toBe(true);
  return (cachedOwnerApi = api);
}

export type Fixture = { email: string; password: string; fullName: string };

/** Creates an active user: the owner invites, the invitation mail is read from Mailpit and accepted. */
export async function createActiveUser(role: 'affiliate' | 'sub_manager', fullName: string): Promise<Fixture> {
  const owner = await ownerApi();
  const email = uniqueEmail(role === 'affiliate' ? 'aff' : 'mgr');
  const created = await owner.post('/api/users', { data: { fullName, email, role } });
  expect(created.status(), 'create user').toBe(201);
  const link = await waitForLink(email, '/invitation');
  const token = new URL(link).searchParams.get('token');
  const password = newPassword(role);
  const accepted = await owner.post('/api/auth/invite/accept', { data: { token, password } });
  expect(accepted.status(), 'accept invitation').toBe(204);
  return { email, password, fullName };
}

export async function freshContext(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  return browser.newContext({ baseURL: WEB_ORIGIN, locale: 'fr-FR', ...options });
}

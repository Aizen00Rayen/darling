import fs from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  SETUP_TOKEN,
  linkMailedTo,
  money,
  need,
  newContext,
  readState,
  sessionFile,
  strongPassword,
  totpCode,
  writeState,
} from './helpers';

// Launch scenarios, in order. They are SERIAL and build on each other:
//   1 creates the owner (and saves his session),  2 invites the sous-manager and the influenceuse (saved sessions),
//   3 places an order with her link and takes it to delivered and paid,  4 login errors and throttling,
//   5 her portal on a phone,  6 the storefront,  7 the diagnostics page.
// State is handed over through a small file (helpers.ts); a scenario run alone fails with an explicit message.

test.describe.configure({ mode: 'serial' });

const RUN = Math.random().toString(36).slice(2, 8);
const OWNER_EMAIL = `owner-${RUN}@e2e.darling.test`;
const MANAGER_EMAIL = `manager-${RUN}@e2e.darling.test`;
const AFFILIATE_EMAIL = `aya-${RUN}@e2e.darling.test`;
const AFFILIATE_PHONE = '0551020304';
const CUSTOMER_PHONE = '0661234567';
const SECOND_CUSTOMER_PHONE = '0778901234';

/** Client-side navigation keeps the previous page in the DOM (hidden): only look at what the visitor can see. */
function labelled(page: Page, label: string | RegExp, options?: { exact?: boolean }) {
  return page.getByLabel(label, options).filter({ visible: true });
}

/** The page's own error notice (Next's empty route announcer is also an alert). */
const alertOf = (page: Page) => page.getByRole('alert').filter({ hasText: /\S/ });

async function loginWithForm(page: Page, email: string, password: string) {
  await page.goto('/connexion');
  await labelled(page, 'Adresse e-mail').fill(email);
  await labelled(page, 'Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

async function inviteUser(page: Page, user: { name: string; email: string; phone: string; role: string; manager?: string }) {
  await page.goto('/admin/utilisateurs/nouveau');
  await labelled(page, 'Nom complet').fill(user.name);
  await labelled(page, 'Adresse e-mail').fill(user.email);
  await labelled(page, /^Téléphone/).fill(user.phone);
  await labelled(page, 'Rôle').selectOption({ label: user.role });
  if (user.manager) await labelled(page, 'Sous-manager', { exact: true }).selectOption({ label: user.manager });
  await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
  await expect(page).toHaveURL(/\/admin\/utilisateurs\/[0-9a-f-]{36}\?created=1/);
}

/** Opens the mailed invitation link in a fresh context, chooses a password, logs in and saves the session. */
async function acceptInvitation(browser: Browser, email: string, password: string, home: RegExp, sessionName: string) {
  await expect.poll(() => linkMailedTo(email, '/invitation'), { message: `no invitation mail for ${email}` }).toBeTruthy();
  const link = linkMailedTo(email, '/invitation') as string;
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(link);
  await labelled(page, 'Nouveau mot de passe').fill(password);
  await labelled(page, 'Confirmer le mot de passe').fill(password);
  await page.getByRole('button', { name: 'Activer mon compte' }).click();
  await expect(page).toHaveURL(/\/connexion/);
  await loginWithForm(page, email, password);
  await expect(page).toHaveURL(home);
  await context.storageState({ path: sessionFile(sessionName) });
  await context.close();
}

test('1. first-run setup, login, forced 2FA enrolment, then /configuration is closed', async ({ browser }) => {
  const password = strongPassword('owner');
  const name = 'Nour Propriétaire';
  const context = await newContext(browser);
  const page = await context.newPage();

  await page.goto('/configuration');
  await expect(page.getByRole('heading', { name: 'Configuration initiale' })).toBeVisible();
  await labelled(page, 'Jeton de configuration').fill(SETUP_TOKEN);
  await labelled(page, 'Nom complet').fill(name);
  await labelled(page, 'Adresse e-mail').fill(OWNER_EMAIL);
  await labelled(page, 'Mot de passe', { exact: true }).fill(password);
  await labelled(page, 'Confirmer le mot de passe').fill(password);
  await page.getByRole('button', { name: 'Créer le compte propriétaire' }).click();

  await expect(page).toHaveURL(/\/connexion\?setup=1/);
  await expect(page.getByRole('heading', { name: 'Configuration initiale' })).toHaveCount(0); // the setup form is gone
  await expect(page.getByRole('status').filter({ hasText: 'Compte propriétaire créé.' })).toBeVisible();

  await labelled(page, 'Adresse e-mail').fill(OWNER_EMAIL);
  await labelled(page, 'Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();

  // 2FA is mandatory for a Super Manager: the portal sends him to the enrolment page and shows no navigation.
  await expect(page).toHaveURL(/\/compte\/securite/);
  await expect(page.getByText('La double authentification est obligatoire pour votre rôle.')).toBeVisible();
  await page.getByRole('button', { name: 'Activer', exact: true }).click();
  const secret = (await labelled(page, 'Clé de configuration').innerText()).replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  const twoFactor = page.getByRole('region', { name: 'Double authentification' });
  await twoFactor.getByLabel('Mot de passe actuel').fill(password);
  await twoFactor.getByLabel('Code à 6 chiffres').fill(totpCode(secret));
  await twoFactor.getByRole('button', { name: 'Confirmer l’activation' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  const nav = page.getByRole('navigation', { name: 'Navigation principale' });
  await expect(nav.getByRole('link', { name: 'Utilisateurs' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Diagnostic' })).toBeVisible();
  writeState({ owner: { email: OWNER_EMAIL, password, name, totpSecret: secret } });

  // Log out and back in: the second factor is now asked (a code from the NEXT 30 s step, so it is not a replay).
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/connexion/);
  await labelled(page, 'Adresse e-mail').fill(OWNER_EMAIL);
  await labelled(page, 'Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await labelled(page, 'Code de vérification').fill(totpCode(secret, 1));
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await context.storageState({ path: sessionFile('owner') });
  await context.close();

  // The setup page is closed for good (any visitor, signed in or not).
  const visitor = await newContext(browser);
  const other = await visitor.newPage();
  await other.goto('/configuration');
  await expect(other).toHaveURL(/\/connexion$/);
  await visitor.close();
});

test('2. the owner invites a sous-manager and an influenceuse; both accept and land in their portal', async ({ browser }) => {
  need('owner', 'scenario 1 creates the owner');
  const owner = await newContext(browser, { storageState: sessionFile('owner') });
  const page = await owner.newPage();
  const managerName = 'Karim Sous-Manager';
  const affiliateName = 'Aya Influenceuse';

  const managerPassword = strongPassword('manager');
  const affiliatePassword = strongPassword('aya');

  // The sous-manager must be active before he can be chosen as her manager.
  await inviteUser(page, { name: managerName, email: MANAGER_EMAIL, phone: '0550112233', role: 'Sous-manager' });
  await acceptInvitation(browser, MANAGER_EMAIL, managerPassword, /\/manager$/, 'manager');
  await inviteUser(page, { name: affiliateName, email: AFFILIATE_EMAIL, phone: AFFILIATE_PHONE, role: 'Influenceuse', manager: managerName });
  await acceptInvitation(browser, AFFILIATE_EMAIL, affiliatePassword, /\/affiliate$/, 'affiliate');
  await owner.close();

  // Each portal keeps the other roles out.
  const manager = await newContext(browser, { storageState: sessionFile('manager') });
  const managerPage = await manager.newPage();
  await managerPage.goto('/admin');
  await expect(managerPage).toHaveURL(/\/manager$/);
  await expect(managerPage.getByRole('button', { name: 'Se déconnecter' })).toBeVisible();
  await manager.close();

  const affiliate = await newContext(browser, { storageState: sessionFile('affiliate') });
  const affiliatePage = await affiliate.newPage();
  await affiliatePage.goto('/admin');
  await expect(affiliatePage).toHaveURL(/\/affiliate$/);
  const code = await labelled(affiliatePage, 'Votre code', { exact: true }).inputValue();
  expect(code).toMatch(/^[A-Z]{3}\d{3}$/);
  await affiliate.close();

  writeState({
    manager: { email: MANAGER_EMAIL, password: managerPassword, name: managerName },
    affiliate: { email: AFFILIATE_EMAIL, password: affiliatePassword, name: affiliateName, phone: AFFILIATE_PHONE, code },
  });
});

test('3. an order through her link: attributed, delivered, commissions validated and paid; her portal masks the customer', async ({ browser }) => {
  const affiliate = need('affiliate', 'scenario 2 creates her');
  need('owner', 'scenario 1 creates the owner');

  // --- the customer, in a fresh context, arrives through the link and orders
  const visitor = await newContext(browser);
  const shop = await visitor.newPage();
  await shop.goto(`/?ref=${affiliate.code}`);
  await expect(shop.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(shop).toHaveURL(/\/$/, { timeout: 15_000 }); // the ref parameter is stripped from the address bar
  await labelled(shop, 'Nom et prénom').fill('Samia Ouali');
  await labelled(shop, 'Téléphone').fill(CUSTOMER_PHONE);
  await labelled(shop, 'Wilaya').selectOption({ label: '16 — Alger' });
  await labelled(shop, 'Commune').fill('Bab Ezzouar');
  await labelled(shop, 'À domicile').check();
  await labelled(shop, 'Adresse de livraison').fill('12 rue des Lilas, bâtiment B');
  await shop.getByRole('button', { name: 'CONFIRMER MA COMMANDE' }).click();
  await expect(shop).toHaveURL(/\/merci\?n=DL-\d{2}-\d{6}$/);
  const number = new URL(shop.url()).searchParams.get('n') as string;
  await visitor.close();
  writeState({ order: { number, customerPhone: CUSTOMER_PHONE } });

  // --- the owner sees it attributed and moves it along
  const owner = await newContext(browser, { storageState: sessionFile('owner') });
  const page = await owner.newPage();
  await page.goto('/admin/commandes');
  await page.getByRole('link', { name: number }).click();
  await expect(page.getByRole('heading', { name: number })).toBeVisible();
  const attribution = page.getByRole('region', { name: 'Affiliation' });
  await expect(attribution.getByText(affiliate.code)).toBeVisible();
  await expect(attribution.getByRole('link', { name: affiliate.name })).toBeVisible();
  await expect(attribution.getByText('Lien d’affiliation (clic)')).toBeVisible();

  const step = async (button: string, dialogConfirm: string, notice: string) => {
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: dialogConfirm, exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: notice })).toBeVisible();
  };
  await step('Confirmer la commande', 'Confirmer', 'Commande confirmée.');
  await step('Marquer comme expédiée', 'Marquer expédiée', 'Commande expédiée.');
  await step('Marquer comme livrée', 'Marquer livrée', 'Commande livrée.');

  // delivery validates the commissions: 300 DA for her, 200 DA for her sous-manager
  const commissions = page.getByRole('list', { name: 'Commissions de cette commande' });
  const hers = commissions.getByRole('listitem').filter({ hasText: affiliate.name });
  const his = commissions.getByRole('listitem').filter({ hasText: need('manager', 'scenario 2 creates him').name });
  await expect(hers).toContainText(money(300));
  await expect(hers).toContainText('Validée');
  await expect(his).toContainText(money(200));
  await expect(his).toContainText('Validée');

  // --- pay her
  await page.goto('/admin/commissions');
  await page.getByRole('button', { name: `Payer ${affiliate.name}` }).click();
  const dialog = page.getByRole('dialog', { name: `Payer ${affiliate.name}` });
  await expect(dialog.getByText(money(300)).first()).toBeVisible();
  await dialog.getByRole('button', { name: /^Payer\s300/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /Paiement de .*300.* enregistré\./ })).toBeVisible();
  await owner.close();

  // --- her portal: the payout, the paid commission and a masked customer
  const herContext = await newContext(browser, { storageState: sessionFile('affiliate') });
  const mine = await herContext.newPage();
  await mine.goto('/affiliate');
  await expect(mine.getByText(/Payée/i).first()).toBeVisible();
  await expect(mine.getByText(money(300)).first()).toBeVisible();
  await expect(mine.getByText('Samia O.')).toBeVisible();
  const text = (await mine.locator('body').innerText()) + (await mine.content());
  expect(text).not.toMatch(/Ouali/);
  expect(text).not.toMatch(/66\D{0,2}12\D{0,2}34\D{0,2}56\D{0,2}7/); // the customer phone, however it is spaced
  expect(text).not.toContain('Bab Ezzouar');
  expect(text).not.toContain('Lilas');
  await herContext.close();
});

test('4. wrong credentials: one neutral message for real and unknown accounts, then throttling', async ({ browser }) => {
  const manager = need('manager', 'scenario 2 creates him');
  const neutral = 'E-mail ou mot de passe incorrect.';

  const attempt = async (page: Page, email: string) => {
    await labelled(page, 'Adresse e-mail').fill(email);
    await labelled(page, 'Mot de passe').fill('Mauvais-mot-de-passe-2026');
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/auth/login')), page.getByRole('button', { name: 'Se connecter' }).click()]);
  };

  // unknown address, its own client address
  const unknownCtx = await newContext(browser);
  const unknown = await unknownCtx.newPage();
  await unknown.goto('/connexion');
  await attempt(unknown, `nobody-${RUN}@e2e.darling.test`);
  await expect(alertOf(unknown)).toHaveText(neutral);
  await unknownCtx.close();

  // a real account: the same message, five times, then the per-address throttle
  const realCtx = await newContext(browser);
  const real = await realCtx.newPage();
  await real.goto('/connexion');
  for (let i = 1; i <= 5; i += 1) {
    await attempt(real, manager.email);
    await expect(alertOf(real)).toHaveText(neutral);
  }
  await attempt(real, manager.email);
  await expect(alertOf(real)).toHaveText('Trop de tentatives. Réessayez dans une minute.');
  await realCtx.close();
});

test('5. the influenceuse on a phone: no horizontal scroll, the menu drawer, logout', async ({ browser }) => {
  need('affiliate', 'scenario 2 creates her');
  const context = await newContext(browser, { storageState: sessionFile('affiliate'), viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  await page.goto('/affiliate');
  await expect(page.getByText(/Bonjour/).first()).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const menu = page.getByRole('button', { name: /menu$/i });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/connexion/);
  // and the session is really gone
  await page.goto('/affiliate');
  await expect(page).toHaveURL(/\/connexion/);
  await context.close();
});

test('6. storefront: product, price, shades, delivery total, hidden honeypot, order', async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toContainText(/wet\s*kiss/i);
  await expect(page.getByText(money(3300)).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choisir une teinte' }).getByRole('button')).toHaveCount(4);

  const total = page.locator('.totals strong');
  const before = await total.innerText();
  await labelled(page, 'Wilaya').selectOption({ label: '16 — Alger' });
  await expect(total).not.toHaveText(before);

  // the honeypot is invisible to people and to assistive technology
  const honeypot = page.locator('.hp-field');
  await expect(honeypot).toHaveAttribute('aria-hidden', 'true');
  expect(await page.getByRole('textbox', { name: /website/i }).count()).toBe(0);
  const box = await honeypot.boundingBox();
  expect((box?.width ?? 0) <= 1 && (box?.height ?? 0) <= 1).toBe(true);

  await labelled(page, 'Nom et prénom').fill('Lina Mansouri');
  await labelled(page, 'Téléphone').fill(SECOND_CUSTOMER_PHONE);
  await labelled(page, 'Commune').fill('Kouba');
  await labelled(page, 'À domicile').check();
  await labelled(page, 'Adresse de livraison').fill('5 avenue des Orangers');
  await page.getByRole('button', { name: 'CONFIRMER MA COMMANDE' }).click();
  await expect(page).toHaveURL(/\/merci\?n=DL-\d{2}-\d{6}$/);
  await context.close();
});

test('7. diagnostics: the owner sees the real address verdict, can back up and download', async ({ browser }) => {
  need('owner', 'scenario 1 creates the owner');
  const ip = '198.51.100.77';
  const context = await newContext(browser, { storageState: sessionFile('owner'), extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  const page = await context.newPage();
  await page.goto('/admin/diagnostics');
  await expect(page.getByRole('heading', { name: 'Diagnostic', level: 1 })).toBeVisible();
  await expect(page.getByText('L’adresse IP réelle est détectée')).toBeVisible();
  await expect(page.getByRole('strong').filter({ hasText: ip })).toBeVisible(); // the address derived for THIS request
  await expect(page.getByRole('code').filter({ hasText: ip })).toBeVisible(); // ... and the header it came from
  await expect(page.getByText('Pilote SQLite')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Envoyer un e-mail de test' })).toBeDisabled(); // no SMTP in the test run

  await page.getByRole('button', { name: 'Sauvegarder maintenant' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Sauvegarde créée : darling-\d{8}-\d{6}\.sqlite/ })).toBeVisible();

  await page.getByRole('button', { name: 'Télécharger la dernière sauvegarde' }).click();
  const dialog = page.getByRole('dialog', { name: 'Télécharger la sauvegarde' });
  await expect(dialog.getByText('toutes les données personnelles')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Télécharger', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^darling-\d{8}-\d{6}\.sqlite$/);
  const file = await download.path();
  expect(fs.readFileSync(file).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  await context.close();

  // the state file is private to the run, but make sure scenario 3 left what the summary needs
  expect(readState().order?.number).toMatch(/^DL-/);
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  bootstrap,
  createActiveUser,
  freshContext,
  freshTotpCode,
  hydrated,
  loginViaUi,
  newPassword,
  saveOwner,
  reserveLogins,
  saveOwnerSession,
  setPassword,
  spendLoginWindow,
  submitLogin,
  uniqueEmail,
  waitForLink,
} from './helpers';

/**
 * Foundation end-to-end tests. They share one database and one owner (created by globalSetup), so
 * they run serially, in this order. Only the first test needs the owner's own session; the others
 * that need an owner (to create fixtures) reuse what it saved under e2e/.tmp (see `ownerApi`).
 * All e-mails are unique, so the other tests do not depend on each other's data.
 */

const WRONG_CREDENTIALS = 'E-mail ou mot de passe incorrect.';
const THROTTLED = 'Trop de tentatives. Réessayez dans une minute.';

const bonjour = (page: Page) => page.getByRole('heading', { name: /^Bonjour/ });

test('owner bootstrap → 2FA enrollment → invite sub-manager → sub-manager logs in to /manager and cannot open /admin', async ({
  page,
  browser,
}) => {
  const owner = bootstrap();
  const ownerPassword = newPassword('owner');

  // The invitation link printed by the create-owner CLI: choose a password.
  await page.goto(owner.invitationUrl);
  await expect(page.getByRole('heading', { name: `Bienvenue, ${owner.name}` })).toBeVisible();
  await setPassword(page, ownerPassword, 'Activer mon compte');
  await expect(page).toHaveURL(/\/connexion\?invited=1/);
  await expect(page.getByText('Compte activé. Vous pouvez vous connecter.')).toBeVisible();

  // A Super Manager must enrol in 2FA before anything else.
  await submitLogin(page, owner.email, ownerPassword);
  await expect(page).toHaveURL(/\/compte\/securite\?setup=1$/);

  const twoFactor = page.getByRole('region', { name: 'Double authentification' });
  const activate = twoFactor.getByRole('button', { name: 'Activer', exact: true });
  await hydrated(activate);
  await activate.click();
  const secret = ((await twoFactor.getByLabel('Clé de configuration').textContent()) ?? '').replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await twoFactor.getByLabel('Mot de passe actuel').fill(ownerPassword);
  await twoFactor.getByLabel('Code à 6 chiffres').fill(await freshTotpCode(secret));
  await twoFactor.getByRole('button', { name: 'Confirmer l’activation' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(bonjour(page)).toBeVisible();
  saveOwner({ email: owner.email, password: ownerPassword, totpSecret: secret });
  await saveOwnerSession(page.context());

  // Utilisateurs → Nouvel utilisateur: invite a sub-manager.
  await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Utilisateurs' }).click();
  await expect(page).toHaveURL(/\/admin\/utilisateurs$/);
  await page.getByRole('link', { name: 'Nouvel utilisateur' }).first().click();
  await expect(page).toHaveURL(/\/admin\/utilisateurs\/nouveau$/);

  const managerEmail = uniqueEmail('sub');
  await hydrated(page.getByRole('button', { name: 'Envoyer l’invitation' }));
  await page.getByLabel('Nom complet').fill('Samia Sous-Manager');
  await page.getByLabel('Adresse e-mail').fill(managerEmail);
  await page.getByLabel('Rôle').filter({ visible: true }).selectOption({ label: 'Sous-manager' });
  await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
  await expect(page).toHaveURL(/\/admin\/utilisateurs\/[0-9a-f-]{36}\?created=1$/);
  await expect(page.getByText(`Invitation envoyée à ${managerEmail}.`)).toBeVisible();

  // The sub-manager accepts the mailed invitation in a fresh browser context and logs in.
  const managerContext = await freshContext(browser);
  try {
    const managerPage = await managerContext.newPage();
    await managerPage.goto(await waitForLink(managerEmail, '/invitation'));
    const managerPassword = newPassword('sub');
    await setPassword(managerPage, managerPassword, 'Activer mon compte');
    await expect(managerPage).toHaveURL(/\/connexion\?invited=1/);
    await loginViaUi(managerPage, managerEmail, managerPassword, /\/manager$/);
    await expect(bonjour(managerPage)).toBeVisible();

    // The admin area is not theirs: they end up back on their own home.
    await managerPage.goto('/admin');
    await expect(managerPage).toHaveURL(/\/manager$/);
  } finally {
    await managerContext.close();
  }
});

test('forgotten password e-mail resets the password and old sessions stop working', async ({ browser }) => {
  const affiliate = await createActiveUser('affiliate', 'Amel Influenceuse');

  const contextA = await freshContext(browser);
  const contextB = await freshContext(browser);
  try {
    const pageA = await contextA.newPage();
    await loginViaUi(pageA, affiliate.email, affiliate.password, /\/affiliate$/);
    await expect(bonjour(pageA)).toBeVisible();

    // Context B: "Mot de passe oublié" → mail → new password.
    const pageB = await contextB.newPage();
    await pageB.goto('/connexion');
    await pageB.getByRole('link', { name: 'Mot de passe oublié ?' }).click();
    await expect(pageB).toHaveURL(/\/mot-de-passe-oublie$/);
    const send = pageB.getByRole('button', { name: 'Envoyer le lien' });
    await hydrated(send);
    await pageB.getByLabel('Adresse e-mail').filter({ visible: true }).fill(affiliate.email);
    await send.click();
    await expect(pageB.getByText('Si un compte existe pour cette adresse, un lien vient d’être envoyé.')).toBeVisible();

    const newPass = newPassword('reset');
    await pageB.goto(await waitForLink(affiliate.email, '/reinitialiser'));
    await setPassword(pageB, newPass, 'Mettre à jour');
    await expect(pageB).toHaveURL(/\/connexion\?reset=1/);
    await expect(pageB.getByText('Mot de passe mis à jour. Vous pouvez vous connecter.')).toBeVisible();

    // The session of context A died with the old password.
    await pageA.goto('/affiliate');
    await expect(pageA).toHaveURL(/\/connexion/);

    // The old password is refused; the new one works.
    await submitLogin(pageB, affiliate.email, affiliate.password);
    await expect(pageB.getByText(WRONG_CREDENTIALS)).toBeVisible();
    await submitLogin(pageB, affiliate.email, newPass);
    await expect(pageB).toHaveURL(/\/affiliate$/);
    await expect(bonjour(pageB)).toBeVisible();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test('affiliate on a 375 px screen sees the drawer navigation and her dashboard', async ({ browser }) => {
  const affiliate = await createActiveUser('affiliate', 'Nadia Mobile');
  const context = await freshContext(browser, { viewport: { width: 375, height: 812 } });
  try {
    const page = await context.newPage();
    await loginViaUi(page, affiliate.email, affiliate.password, /\/affiliate$/);
    await expect(bonjour(page)).toBeVisible();

    const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noHorizontalScroll()).toBe(true);

    const menu = page.getByRole('button', { name: /menu/i });
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Tableau de bord' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Mon compte' })).toBeVisible();
    expect(await noHorizontalScroll()).toBe(true);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(bonjour(page)).toBeVisible();

    // Logout lives in the drawer.
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/connexion/);
  } finally {
    await context.close();
  }
});

test('storefront home still renders the Wet Kiss page and its order form', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /WET KISS/i })).toBeVisible();
  await expect(page.getByText(/3[\s  ]000[\s  ]DA/).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choisir une teinte' }).getByRole('button')).toHaveCount(4);

  const form = page.locator('form#commande');
  const submit = form.getByRole('button', { name: /CONFIRMER MA COMMANDE/ });
  await hydrated(submit);
  const total = form.locator('.totals strong');
  const before = await total.innerText();

  await form.getByLabel('Nom et prénom').fill('Lina Cliente');
  await form.getByLabel('Téléphone').fill('0555123456');
  await form.getByLabel('Wilaya').selectOption({ index: 16 });
  await expect(total).not.toHaveText(before);
  await form.getByLabel('Commune').fill('Bab El Oued');
  if (await form.getByLabel('Adresse de livraison').isVisible()) {
    await form.getByLabel('Adresse de livraison').fill('12 rue des Tests');
  }
  await submit.click();

  await expect(page).toHaveURL(/\/merci$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

/**
 * Last on purpose: it spends the login budget of the minute. The API throttles login to 5
 * attempts per minute per IP, which comes before the 10-failure account lock-out, so the plan's
 * "ten wrong passwords" scenario cannot be driven through the UI from one IP (the lock-out itself is
 * covered by the apps/api tests). This test checks what the UI can show instead: no account
 * enumeration, and throttling after a handful of attempts (at most 6 here).
 */
test('wrong passwords never reveal whether the e-mail exists, and repeated attempts are throttled', async ({ page }) => {
  const affiliate = await createActiveUser('affiliate', 'Salma Verrou');
  const unknownEmail = uniqueEmail('nobody');

  await page.goto('/connexion');
  await hydrated(page.getByRole('button', { name: 'Se connecter' }));
  // The first two attempts below are ours to count; the throttle then bites within the next four.
  await reserveLogins(2);

  const attempt = async (email: string): Promise<number> => {
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(newPassword('wrong'));
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Se connecter' }).click(),
    ]);
    return response.status();
  };

  // Same answer for an e-mail that exists and one that does not.
  expect(await attempt(affiliate.email)).toBe(401);
  await expect(page.getByRole('alert').filter({ hasText: WRONG_CREDENTIALS })).toBeVisible();
  expect(await attempt(unknownEmail)).toBe(401);
  await expect(page.getByRole('alert').filter({ hasText: WRONG_CREDENTIALS })).toBeVisible();

  // Then the throttle kicks in (the fifth request of the minute is the last one allowed).
  let status = 401;
  for (let tries = 0; tries < 4 && status !== 429; tries += 1) status = await attempt(affiliate.email);
  expect(status).toBe(429);
  await spendLoginWindow();
  await expect(page.getByRole('alert').filter({ hasText: THROTTLED })).toBeVisible();
});


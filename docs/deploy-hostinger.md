# Deploying DARLING* on Hostinger (Node.js, SQLite)

This guide is for the owner, step by step, without a developer. It assumes a Hostinger **Business web hosting** or
**Cloud** plan with the Node.js app feature. Menu names in hPanel change from time to time: if a label differs a little,
look for the closest one.

Plain words:

- **hPanel** is Hostinger's control panel.
- An **environment variable** is a named setting you type into hPanel (for example `APP_ORIGIN`). The app reads them when it starts.
- **SQLite** is the database: a single file. It lives in a folder called `DATA_DIR` that you create **outside** the app folder.

## What is verified and what is not

Read this first. It is honest about what we know.

| Statement | Status |
| --- | --- |
| The app itself: setup page, login, 2FA, orders, commissions, payouts, backups, diagnostics, cron endpoint, startup checks | **Verified by us**: automated tests (unit and end-to-end in a real browser) and a local production build started with a production-like configuration. |
| Hostinger offers Node.js 18/20/22/24, deploys from a GitHub repository (build `npm run build`, start `npm start`), up to 5 Node apps on Business, about 120 shared processes, a 120 second request limit, idle apps stopped until the next visit, background work only through hPanel cron jobs (which can run `curl`), MySQL-only managed databases, no Docker or Redis | **From Hostinger's documentation** (researched, not tested by us on your plan). |
| The SQLite file **survives a redeploy** when `DATA_DIR` is outside the app folder | **UNVERIFIED.** Hostinger does not document it. You verify it yourself in step 1 with `deploy-check/`. **Do not skip step 1.** |
| The **real visitor IP** reaches the app (header `X-Forwarded-For`, maybe `X-Real-IP`) and one proxy sits in front (`TRUSTED_PROXY_HOPS=1`) | **UNVERIFIED.** The page **Diagnostic** shows the truth for your site (step 7). |
| `node:sqlite` (built into Node 22) works on your plan | **UNVERIFIED but checked by `deploy-check/`** (step 1). The app falls back to `better-sqlite3` if it does not. |
| The path of your home folder (`/home/u123456789/...`) | **UNVERIFIED for your account.** Confirm it in File Manager (step 2). |
| The mail server accepts the app's login (`smtps://...:465`) | **UNVERIFIED** until you press "Envoyer un e-mail de test" (step 8). |
| An hPanel cron job can call your own site with `curl` | **From Hostinger's documentation**; confirmed for your site when the first backup appears (step 9). |

## Before you deploy (checklist)

- [ ] The code you want live is merged into the branch **`main`** of the GitHub repository `Aizen00Rayen/darling`
      (the launch work is on branch `feat/launch`: merge it into `main` first, for example with a pull request on GitHub).
- [ ] Your domain points to the Hostinger plan and has an SSL certificate (https). The site URL below is written `https://darling7.store`: use yours.
- [ ] You created a **mailbox** in hPanel -> Emails (for example `no-reply@darling7.store`). You need its password.
- [ ] You have a password manager open to save the secrets from step 3.
- [ ] You know which Node.js version to pick: **22** (or 24).

## Step 1. Run `deploy-check/` first (10 minutes)

This tiny test app tells you whether a SQLite file survives a redeploy on **your** plan. If it does not, stop and
contact Hostinger support before going further.

1. hPanel -> Websites -> Add website -> **Node.js** app -> import the GitHub repository (or upload the `deploy-check/` folder).
2. Set the **root directory** to `deploy-check`, leave the build command empty, start command `npm start`, Node.js **22**.
3. Open the site URL. You see some JSON. Check that `node_sqlite` or `better_sqlite3` says `"ok": true`.
4. Reload twice: `visits` must increase.
5. **Redeploy** (button in hPanel, or push a tiny change) and reload: `visits` must keep counting and `firstVisit` must not change.
   - If it restarts at 1, the data folder is wiped by redeploys. Add the variable `DATA_DIR` set to a folder **outside** the app
     (see step 2 for how to build the path), redeploy, and repeat steps 3 to 5.
6. Write down the result. Delete this test app when you are done.

## Step 2. Create the data folder (outside the app)

1. hPanel -> **File Manager**. Look at the path shown at the top. Your home folder looks like `/home/u123456789`
   (the letter `u` followed by digits). The websites are under `domains/...`.
2. In your **home folder** (not inside `domains`, not inside `public_html`, not inside the app folder) create a folder named `darling-data`.
3. Your `DATA_DIR` is then `/home/u123456789/darling-data` (use your own number). Note it down.

The app refuses to start in production if `DATA_DIR` is inside the app folder, because a redeploy could erase it.

## Step 3. Generate the secrets

You need three random values: `ENCRYPTION_KEY`, `SETUP_TOKEN`, `CRON_TOKEN`. Generate them yourself. Never use an
online generator and never reuse a value.

**With a terminal** (your own computer on macOS or Linux, or hPanel's terminal if your plan has one):

```bash
openssl rand -base64 32     # ENCRYPTION_KEY  (44 characters ending with "=")
openssl rand -hex 32        # SETUP_TOKEN     (64 characters)
openssl rand -hex 32        # CRON_TOKEN      (64 characters, a different one)
```

**Without `openssl`** (any computer with Node.js 22 installed, or hPanel's terminal if available):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"      # SETUP_TOKEN, then again for CRON_TOKEN
```

**On Windows without Node.js** (PowerShell, offline, uses the system's secure random generator):

```powershell
$b = New-Object byte[] 32; $r = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $r.GetBytes($b)
[Convert]::ToBase64String($b)                                  # ENCRYPTION_KEY
($b | ForEach-Object { $_.ToString('x2') }) -join ''           # a hex token: run the 3 lines again for each token
```

Rules:

- `ENCRYPTION_KEY` must be exactly the base64 of 32 bytes (a password manager's "random password" is **not** valid for this one).
- `SETUP_TOKEN` and `CRON_TOKEN` need at least 32 characters and no spaces.
- Save all three in your password manager. **If you lose `ENCRYPTION_KEY`, every owner's 2FA must be set up again.**

## Step 4. Create the Node.js app

1. hPanel -> Websites -> Add website -> **Node.js** app -> import from GitHub: repository `Aizen00Rayen/darling`, branch **`main`**
   (authorize GitHub when asked; a private repository needs that).
2. Root directory: the repository root (leave empty / `./`). Node.js version: **22** (or 24).
3. Build command: `npm run build`. Start command: `npm start`. (Hostinger runs `npm install` itself. The app uses plain npm.)
4. **Environment variables**: add every row of the table below, then save. `PORT` is provided by Hostinger: do not set it.

| Variable | Value | Where it comes from |
| --- | --- | --- |
| `NODE_ENV` | `production` | Type it. |
| `APP_ORIGIN` | `https://darling7.store` | Your public address with `https://`, **no path, no trailing slash**. |
| `COOKIE_SECURE` | `true` | Type it. |
| `DATA_DIR` | `/home/u123456789/darling-data` | Step 2 (your own number). |
| `ENCRYPTION_KEY` | 44 characters | Step 3. |
| `TRUSTED_PROXY_HOPS` | `1` | Type it. Confirmed or corrected in step 7. |
| `SETUP_TOKEN` | 64 characters | Step 3. **Temporary**: removed in step 10. |
| `CRON_TOKEN` | 64 characters | Step 3. Enables the automatic backup call. |
| `SMTP_URL` | `smtps://no-reply%40darling7.store:YOUR_PASSWORD@smtp.hostinger.com:465` | See below. |
| `MAIL_FROM` | `DARLING* <no-reply@darling7.store>` | The address of the mailbox, exactly. |
| `BACKUP_KEEP` | `14` (optional) | How many backup files to keep. |

**`SMTP_URL`**: in hPanel -> Emails -> your domain -> the mailbox -> **Configuration / connect apps**, you find the outgoing
server (Hostinger: `smtp.hostinger.com`, port `465` with SSL/TLS; confirm what hPanel shows for your plan), the user name (the
full address) and the password you chose. Format: `smtps://USER:PASSWORD@HOST:465`.

- Replace special characters with their percent code: `@` becomes `%40`, `#` becomes `%23`, `/` becomes `%2F`, `:` becomes `%3A`,
  `%` becomes `%25`, `?` becomes `%3F`, a space becomes `%20`. So user `no-reply@darling7.store` is written `no-reply%40darling7.store`.
- Avoid the problem by giving the mailbox a long password with letters and digits only.
- The app refuses to start if `SMTP_URL` would send in clear text to another server.

5. Deploy. The first start creates `darling.sqlite` in `DATA_DIR` and applies the database migrations by itself.
   If the app does not start, open the deployment log: the message names the variable to fix (never its value).

You can check your settings before deploying, if you have a terminal and the same variables in a `.env` file:
`npm run preflight` prints a checklist (OK / WARN / FAIL, never a secret) and exits with an error if something is wrong.

## Step 5. Create the owner (`/configuration`)

1. Open `https://darling7.store/configuration`.
2. Enter the **SETUP_TOKEN** (the value you saved), your name, your e-mail and a password (10 characters minimum, not a common one).
3. You are sent to the login page. Log in. The app now **forces 2FA** for Super Managers.

This page only exists while there is no user **and** `SETUP_TOKEN` is set. Afterwards it redirects to the login page.

## Step 6. Set up 2FA

1. On the "Double authentification" page press **Activer**.
2. Scan the QR code with an authenticator app (Google Authenticator, Authy, 1Password...) or type the key under the code.
3. Type your password and the 6 digit code, press **Confirmer l'activation**. You arrive on the dashboard.
4. Write the manual key in your password manager as a recovery copy.

## Step 7. Check the visitor IP (page "Diagnostic")

Open **Diagnostic** in the menu (owners only), or `/admin/diagnostics`.

- Good: **"L'adresse IP réelle est détectée"**. The address shown is your own public IP. Rate limits then work per visitor.
- Bad: **"Attention : l'adresse détectée est locale/privée ou inconnue"**. Every visitor would share the same rate-limit counters:
  one person typing wrong passwords could lock out login for everyone.
  1. Look at the four header lines. If `X-Forwarded-For` is present with two or more addresses, set `TRUSTED_PROXY_HOPS` to `2`; if it is
     absent but `X-Real-IP` is present the app already uses it; save and restart the app and reload the page.
  2. If no header carries your real address, contact Hostinger support and ask which header carries the visitor's address on Node.js apps.
  3. Until it is fixed, the app still works, but the protections are weaker (an attacker is not limited per person).

The same page shows the Node.js version, the database driver, the data folder (exists, writable, free space, **not** inside the app),
the database size, the migrations, the last backup, and whether `SETUP_TOKEN` is still set. It never shows a secret.

## Step 8. Test e-mail

On the Diagnostic page press **Envoyer un e-mail de test**. It sends a message to **your own address** (3 per hour).
If it fails the page tells you why in plain words (wrong login, server unreachable). Fix `SMTP_URL`, restart, try again.
Invitations and password resets depend on this working.

## Step 9. Automatic backups (hPanel cron job)

A backup is a verified copy of the database in `DATA_DIR/backups/`. The newest 14 are kept.

1. Press **Sauvegarder maintenant** on the Diagnostic page once: a backup appears in "Dernière sauvegarde".
2. hPanel -> Advanced -> **Cron Jobs** -> add a custom job. Schedule: every day at 03:00. Command (replace the two parts in capitals):

```bash
curl -fsS -X POST -H "Authorization: Bearer YOUR_CRON_TOKEN" https://YOUR-DOMAIN/api/cron/backup
```

The command is the same as `curl -fsS -X POST -H "Authorization: Bearer $CRON_TOKEN" https://<domain>/api/cron/backup`
when the cron environment defines `$CRON_TOKEN`; hPanel usually does not, so paste the real value.

3. After the first run, check that **"Dernière sauvegarde"** shows the new time. The route answers 404 if `CRON_TOKEN` is not set,
   401 for a wrong token, 429 above 10 calls an hour. If the site was asleep the first call is slow: that is normal.
4. **Backups live on the same disk as the database.** About once a week press **Télécharger la dernière sauvegarde** and keep the
   file somewhere else. It contains **all personal data** (customers' names, phones and addresses, accounts, encrypted 2FA
   secrets): store it safely, do not e-mail it, delete old copies.

## Step 10. Remove `SETUP_TOKEN`

Now that the owner exists, delete the `SETUP_TOKEN` variable in hPanel and restart. (It does nothing once a user exists, but a
secret you do not need should not stay.) The Diagnostic page tells you if it is still there.

## Step 11. Test an order from a phone

1. On your phone open `https://darling7.store`, pick a shade, a wilaya, fill the form with a real number of yours, confirm.
2. You land on "Merci" with an order number `DL-YY-NNNNNN`. In the admin go to **Commandes**: the order is there, status "Nouvelle".
3. Move it to "Confirmée" to check the buttons work, then cancel it ("Annuler la commande") so it does not count.

## Step 12. Test the influenceuse flow

1. **Utilisateurs** -> **Nouvel utilisateur**: create a test sous-manager (role "Sous-manager"), then a test influenceuse (role
   "Influenceuse", assigned to him). Both need a mobile number. Each receives an invitation e-mail (use mailboxes you control).
2. Accept both invitations (open the link, choose a password) and log in: the sous-manager lands on `/manager`, the influenceuse on `/affiliate`.
3. Open her link `https://darling7.store/?ref=HER-CODE` in a private window, place an order. In the admin the order shows her code under
   "Affiliation".
4. Move the order to "Confirmée", "Expédiée", "Livrée": 300 DA (influenceuse) and 200 DA (sous-manager) become "Validée".
   Pay her in **Commissions** -> "Payer". Her portal shows the payout and "Payée"; the customer appears only as first name + initial.
5. Clean up: cancel test orders, suspend the test users (Utilisateurs -> the user -> Suspendre).

## Go-live checklist

- [ ] `deploy-check` passed: the data survives a redeploy (step 1).
- [ ] `DATA_DIR` is outside the app folder and the Diagnostic page shows it writable with free space.
- [ ] Diagnostic says "L'adresse IP réelle est détectée".
- [ ] Owner has 2FA; the recovery key is in the password manager. A second owner is a good idea (Utilisateurs -> Propriétaire).
- [ ] Test e-mail received.
- [ ] A backup exists, the cron job ran once, and you downloaded one copy to another place.
- [ ] `SETUP_TOKEN` removed.
- [ ] A phone order and the influenceuse flow worked; test data cancelled.
- [ ] Prices, delivery fees and commission amounts (Paramètres) are the real ones.
- [ ] The three secrets and the SMTP password are saved in your password manager.

## Updating the site

1. Press **Sauvegarder maintenant** (Diagnostic) and download the backup.
2. Push or merge your changes into the branch Hostinger deploys (`main`), then **Redeploy** in hPanel (or let auto-deploy do it).
3. The app applies new database migrations by itself at start. A migration that was already applied can never change (the app refuses to start if it did).
4. Open the Diagnostic page: migrations count, last backup and the IP verdict should still be fine.

## Restoring a backup

Use this only if the database is damaged or wrong data was written. Everything after the backup's time is lost.

1. hPanel -> the Node.js app -> **Stop**.
2. File Manager -> `DATA_DIR/backups/`: pick the file `darling-YYYYMMDD-HHMMSS.sqlite` (the time is Algiers time).
3. **Copy** it to `DATA_DIR/` and rename the copy `darling.sqlite` (replacing the old one; keep the old one under another name for now).
4. **Delete** `darling.sqlite-wal` and `darling.sqlite-shm` in `DATA_DIR/` if they exist (leftovers of the old database).
5. **Start** the app, open the Diagnostic page and check the migrations, then log in and check recent orders.

## Limits and behaviour on shared hosting

- **Idle stop**: after a while without visits the app is stopped; the next visit starts it (a slow first page, a few seconds). The
  rate-limit counters restart empty at that moment.
- **120 second limit** per request: nothing in the app runs that long; a backup of a small database takes well under a second.
- **Process limit**: if the whole hosting account hits its limit of processes, visitors may see a **503**. Wait a minute, or restart
  the app in hPanel; if it keeps happening, stop unused apps or ask Hostinger support.
- **One process**: there is one app process, so memory-based rate limits are enough. Do not run several copies of the app on the same data folder.
- **No background jobs** other than hPanel cron jobs.

## Security notes

- **Stored**: orders (customer name, phone, wilaya, commune, address), user accounts (password hashes with scrypt, TOTP secrets encrypted with
  `ENCRYPTION_KEY`), sessions, the audit log and the login log. No card data (payment is cash on delivery).
- **Where**: only in `DATA_DIR/darling.sqlite` and its backups. Nothing is sent to third parties; e-mail goes through your own mailbox.
- **Backups contain personal data** and password hashes. Treat them like the database itself.
- Passwords are never logged; logs never contain request bodies, cookies or tokens.
- The cron route is the only machine endpoint: bearer token, 10 calls an hour per address, refuses browsers.
- If you suspect a leak: suspend the affected users or revoke their sessions (Utilisateurs), change passwords, replace `CRON_TOKEN`,
  and contact your developer. Changing `ENCRYPTION_KEY` alone does not help and would make every existing 2FA secret unreadable.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Every page answers 500 after deploy and the log says "Invalid configuration: ..." (the app refuses to serve with a bad setting) | A variable is missing or malformed (the message names it, not its value) | Fix that variable, redeploy. `ENCRYPTION_KEY` must be 44 characters ending with `=`; `APP_ORIGIN` must be `https://...` with no path. |
| "DATA_DIR ... must be outside the application directory" | `DATA_DIR` is inside the app folder or empty | Use the folder from step 2. |
| "DATA_DIR ... must be a directory the app can create and write to" | Wrong path or permissions | Check the path in File Manager; create the folder; check you copied the right account number. |
| Everything was reset after a redeploy | The data folder is inside the app folder, or the plan wipes it | Run step 1 again; use a `DATA_DIR` outside the app; restore a backup. |
| `/configuration` redirects to the login page | An owner already exists, or `SETUP_TOKEN` is not set | If no owner exists: set `SETUP_TOKEN`, restart. If one exists: log in. |
| "Jeton de configuration incorrect." | Wrong `SETUP_TOKEN` typed | Copy it again from your password manager (5 tries per 15 minutes). |
| Diagnostic warns the address is local/private | The proxy does not pass the visitor address, or `TRUSTED_PROXY_HOPS` is wrong | Step 7. |
| "Trop de tentatives" for everybody | Same cause: all visitors share one counter | Step 7. |
| The invitation e-mail never arrives | SMTP not configured or wrong password | Diagnostic -> test e-mail; fix `SMTP_URL` (percent-encode special characters); check the spam folder. |
| The test e-mail says the login was refused | Wrong mailbox user/password in `SMTP_URL` | Use the full address as user; re-type the password; encode special characters. |
| The test e-mail says the server is unreachable | Wrong host or port | Use `smtp.hostinger.com` and `465` (or what hPanel shows). |
| No backup appears after the cron time | Wrong token or URL, `CRON_TOKEN` not set, cron job not saved | Run the same `curl` line by hand in a terminal and read the answer: 404 = `CRON_TOKEN` unset, 401 = wrong token. |
| A visitor sees a **503** | Process limit of the hosting account or the app is starting | Wait a minute; restart the app; reduce other apps. |
| First page after a quiet period is slow | The app was stopped for idleness | Normal on shared hosting. |
| "2FA code invalid" right after enabling | Phone clock is off, or the same code was reused | Wait for the next code; set the phone to automatic time. |
| Lost the 2FA device and there is no second owner | | A developer can create a new owner with `npm run create-owner -- --force` on a machine that has the data folder, or restore the database; keep a second owner to avoid this. |

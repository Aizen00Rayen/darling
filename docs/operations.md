# Owner checklist (daily and weekly)

Short routine once DARLING* is live. Setup and recovery are in [`deploy-hostinger.md`](deploy-hostinger.md).

## Every day (5 minutes)

1. **Commandes** (`/admin/commandes`): handle the status "Nouvelle". Call the customer, then **Confirmer la commande**.
   Move confirmed orders to "Expédiée" when the parcel leaves, "Livrée" when it is delivered and paid.
   Use "Annuler la commande" or "Refusée à la livraison" for the unhappy endings (a short note helps later).
2. **Tableau de bord** (`/admin`): the numbers of the day and the "commissions à payer" total.
3. If a customer phones in or writes on Instagram/WhatsApp: **Commandes -> Nouvelle commande** (add the influenceuse's code if she sent the customer).

## Every week

1. **Commissions** (`/admin/commissions`): the "À payer" table lists everyone with validated commissions (a commission becomes
   payable when its order is delivered). Press **Payer**, choose the method, add a reference (receipt or transfer number), confirm.
   One payout settles everything that person is owed, and any earlier returned order is deducted automatically.
2. **Diagnostic** (`/admin/diagnostics`): check that
   - the IP line still says "L'adresse IP réelle est détectée";
   - "Dernière sauvegarde" is from the last 24 hours (the cron job works);
   - free disk space is comfortable and the data folder is outside the app;
   - `SETUP_TOKEN` is not set.
3. **Télécharger la dernière sauvegarde** and keep the file somewhere other than the hosting (it holds personal data: store it
   safely, delete old copies).
4. **Journal** (`/admin/journal`): glance at failed logins and at who changed what.

## When something looks wrong

| You see | Do |
| --- | --- |
| The site is slow only after a quiet period | Nothing: the app was asleep (normal on shared hosting). |
| A 503 error | Wait a minute, restart the app in hPanel. |
| No recent backup | Press **Sauvegarder maintenant**; check the cron job and `CRON_TOKEN` (see the deployment guide, step 9). |
| An influenceuse cannot log in | Utilisateurs -> her account -> **Renvoyer l'invitation** or let her use "Mot de passe oublié ?". |
| Someone's account is compromised | Utilisateurs -> **Révoquer les sessions** and **Suspendre**, then change the password. |
| Wrong or missing data after an update | Restore the latest backup (deployment guide, "Restoring a backup"). |

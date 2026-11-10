# Hostinger deploy check

Purpose: before building on SQLite, confirm on YOUR Hostinger plan that (1) a SQLite option works and
(2) the data file survives a redeploy.

1. In hPanel → Websites → Add website → Node.js Web App → import this repository (or upload the
   `deploy-check/` folder). Set the root directory to `deploy-check`, build command empty, start `npm start`,
   Node.js 22.x (or 24.x).
2. Open the site URL. You should see JSON. Note which of `node_sqlite` / `better_sqlite3` say `"ok": true`,
   and that `scrypt_password_hash.ms` is well under 1000.
3. Reload twice: `visits` must increase.
4. Redeploy (push a trivial change or click Redeploy) and reload: `visits` must CONTINUE counting
   (not restart at 1) and `firstVisit` must not change. If it restarts, the data dir is wiped on redeploy:
   set an environment variable `DATA_DIR` to a folder outside the app directory (for example
   `/home/<your-user>/darling-data`) and repeat steps 2–4.
5. Send me the JSON (and whether the visit counter survived the redeploy). Delete this app afterwards.

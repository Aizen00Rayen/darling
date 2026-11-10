// Deploy check: open the site URL after deploying. It tries each SQLite option,
// writes one row per visit, and shows whether the data file survives a redeploy.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Put the data OUTSIDE the deployed folder when possible: set DATA_DIR in hPanel
// (for example /home/<your-user>/darling-data). Default: ../darling-data next to the app.
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'darling-data');
const results = { node: process.version, platform: `${process.platform}-${process.arch}`, dataDir };

function check(name, fn) {
  try { results[name] = { ok: true, ...fn() }; }
  catch (e) { results[name] = { ok: false, error: String(e && e.message || e).slice(0, 300) }; }
}

function visit() {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.write-test');
  fs.writeFileSync(probe, String(Date.now()));
  results.dataDirWritable = true;

  check('node_sqlite', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'check-node-sqlite.db'));
    db.exec('CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, at TEXT NOT NULL)');
    db.prepare('INSERT INTO visits (at) VALUES (?)').run(new Date().toISOString());
    const row = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM visits').get();
    db.close();
    return { visits: Number(row.n), firstVisit: row.first };
  });

  check('better_sqlite3', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dataDir, 'check-better-sqlite3.db'));
    db.exec('CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, at TEXT NOT NULL)');
    db.prepare('INSERT INTO visits (at) VALUES (?)').run(new Date().toISOString());
    const row = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM visits').get();
    db.close();
    return { visits: row.n, firstVisit: row.first };
  });

  check('scrypt_password_hash', () => {
    const crypto = require('node:crypto');
    const t = Date.now();
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync('test-password', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { ms: Date.now() - t, bytes: hash.length };
  });

  results.freeMemMB = Math.round(os.freemem() / 1048576);
}

http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  try { visit(); } catch (e) { results.fatal = String(e && e.message || e); }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(results, null, 2));
}).listen(process.env.PORT || 3000, () => console.log('deploy-check listening'));

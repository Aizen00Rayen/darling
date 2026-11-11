import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEMO_DATA_DIR, demoDbPath, demoEncryptionKey, demoIsSeeded, main as seed, renderCounts, renderCredentials, summarise } from './demo-seed';
import { resolveDataDir } from '../server/config';
import { openDatabase } from '../server/db/sqlite';

// Local demo: `npm run demo`. Seeds the demo database when it is empty, prints the credentials, then starts the dev
// server on it. No SMTP: invitation and reset links are written to the log. Never for production data: the data
// directory is ./.data-demo (git-ignored) and the credentials are public.

async function run(): Promise<number> {
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write('Refusing to start the demo with NODE_ENV=production.\n');
    return 1;
  }
  const port = (process.env.PORT ?? '').trim() || '3000';
  if (!/^\d{1,5}$/.test(port)) {
    process.stderr.write('PORT must be a number.\n');
    return 1;
  }
  const origin = `http://localhost:${port}`;
  const dataDir = resolveDataDir({ DATA_DIR: process.env.DATA_DIR?.trim() || DEMO_DATA_DIR });
  const env = { ...process.env, DATA_DIR: dataDir, APP_ORIGIN: origin };

  if (demoIsSeeded(dataDir)) {
    const db = openDatabase(demoDbPath(dataDir));
    try {
      process.stdout.write(`Demo database found in ${dataDir} (reset it with: npm run demo:seed -- --reset)\n${renderCredentials(summarise(db), origin)}\n${renderCounts(summarise(db))}`);
    } finally {
      db.close();
    }
  } else {
    const code = await seed([], env);
    if (code !== 0) return code;
  }

  const child = spawn(process.execPath, [path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--port', port], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATA_DIR: dataDir,
      APP_ORIGIN: origin,
      COOKIE_SECURE: 'false',
      ENCRYPTION_KEY: demoEncryptionKey(dataDir, process.env),
      SMTP_URL: '', // links are logged, nothing is mailed
      MAIL_FROM: '',
      SETUP_TOKEN: '',
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  return new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      process.stderr.write(`Could not start next dev: ${err.message}\n`);
      resolve(1);
    });
  });
}

void run().then((code) => {
  process.exitCode = code;
});

import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { buildApp, type AppDeps } from './app';
import { loadConfig } from './config';
import { systemClock } from './lib/clock';

// Resolve relative to this file, not the cwd, so `pnpm --filter` and root runs agree.
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

async function main() {
  const config = loadConfig(process.env);

  // Placeholders until Task 5 (database) and Task 6 (mailer) provide the real ones.
  const deps: AppDeps = {
    config,
    db: {
      execute: () => Promise.reject(new Error('database not configured until Task 5')),
    },
    mailer: {
      send: () => {
        throw new Error('mailer not configured until Task 6');
      },
    },
    clock: systemClock,
  };

  const app = await buildApp(deps);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  // Config errors list key names only; never print config values.
  console.error(err instanceof Error ? err.message : 'fatal startup error');
  process.exit(1);
});

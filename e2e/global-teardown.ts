import fs from 'node:fs';

/** Removes the throwaway data directory, mail outbox and saved sessions of this run. */
export default async function globalTeardown(): Promise<void> {
  const dir = process.env.E2E_RUN_DIR;
  if (dir && /darling-e2e-/.test(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

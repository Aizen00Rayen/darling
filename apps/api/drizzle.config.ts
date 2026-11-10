import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Repo-root .env (git-ignored); in CI the variables come from the environment.
loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
});

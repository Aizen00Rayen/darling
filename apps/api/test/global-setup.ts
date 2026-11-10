import pg from 'pg';
import { runMigrations } from '../src/db/migrate';
import { ownerAdminUrl, TEMPLATE_DB, withDatabase } from './env';

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Builds `darling_test_template` from scratch: the migrated schema plus the same
 * default privileges infra/postgres/init.sql gives the real database. Every test
 * context clones it, so the whole suite pays for migrations once.
 */
export default async function setup(): Promise<void> {
  const adminUrl = ownerAdminUrl();
  const templateUrl = withDatabase(adminUrl, TEMPLATE_DB);

  await withClient(adminUrl, async (admin) => {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [TEMPLATE_DB]);
    if (existing.rowCount) {
      // A template database cannot be dropped until it stops being one.
      await admin.query(`alter database ${TEMPLATE_DB} is_template false`);
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [TEMPLATE_DB],
      );
      await admin.query(`drop database ${TEMPLATE_DB}`);
    }
    await admin.query(`create database ${TEMPLATE_DB} owner darling_owner`);
  });

  // Default privileges are per database and not inherited from `postgres`/template1.
  await withClient(templateUrl, async (template) => {
    await template.query('alter schema public owner to darling_owner');
    await template.query('grant usage on schema public to darling_app');
    await template.query(
      'alter default privileges for role darling_owner in schema public grant select, insert, update, delete on tables to darling_app',
    );
    await template.query(
      'alter default privileges for role darling_owner in schema public grant usage, select on sequences to darling_app',
    );
  });

  await runMigrations(templateUrl);

  await withClient(adminUrl, (admin) => admin.query(`alter database ${TEMPLATE_DB} is_template true`));
}

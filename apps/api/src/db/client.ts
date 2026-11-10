import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export type DbHandle = { db: Db; close(): Promise<void> };

export function createDb(url: string): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // An idle client dropping (server restart) must not crash the process.
  pool.on('error', () => {});
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}

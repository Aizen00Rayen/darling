import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

/** The handle a transaction callback receives; it has the same query API as `Db`. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything services accept so they work both on their own and inside a transaction. */
export type DbExecutor = Db | DbTx;

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

import { applyMigrations } from '../db/migrate';
import { openDatabase, type Db } from '../db/sqlite';
import { fixedClock, type FixedClock } from '../clock';

/** Test harness: a fresh, fully migrated in-memory database and a clock that only moves when told to. */
export function createTestDb(): { db: Db; clock: FixedClock } {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  return { db, clock: fixedClock() };
}

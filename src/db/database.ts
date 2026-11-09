import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');
  return db;
}

/**
 * Run `fn` in a short BEGIN IMMEDIATE transaction. Never perform network I/O inside `fn`.
 * Throwing rolls everything back. Do not nest.
 */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

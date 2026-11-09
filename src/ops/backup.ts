import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface BackupInfo { file: string; bytes: number; sha256: string; integrity: string; schemaVersion: number }

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Consistent online backup via SQLite's backup API (safe while the bot runs), verified with integrity_check. */
export async function backupDatabase(dbPath: string, backupDir: string, keep: number): Promise<BackupInfo> {
  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, `bluedex-${stamp()}.db`);
  const src = new Database(dbPath, { readonly: false, timeout: 5000 });
  try { await src.backup(dest); } finally { src.close(); }
  const info = verifyBackup(dest);
  if (info.integrity !== 'ok') { rmSync(dest, { force: true }); throw new Error(`backup failed integrity_check: ${info.integrity}`); }
  const all = readdirSync(backupDir).filter((f) => /^bluedex-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(backupDir, old), { force: true });
  return info;
}

export function verifyBackup(file: string): BackupInfo {
  const db = new Database(file, { readonly: true });
  try {
    const integrity = String(db.pragma('integrity_check', { simple: true }));
    const v = db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null };
    return { file, bytes: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), integrity, schemaVersion: v.v ?? 0 };
  } finally { db.close(); }
}

/** Restore `backupFile` over `dbPath`. The bot MUST be stopped. The previous DB is moved aside, never deleted. */
export function restoreDatabase(backupFile: string, dbPath: string): { movedAside?: string; restored: BackupInfo } {
  const check = verifyBackup(backupFile);
  if (check.integrity !== 'ok') throw new Error(`refusing to restore: backup integrity_check = ${check.integrity}`);
  mkdirSync(dirname(dbPath), { recursive: true });
  let movedAside: string | undefined;
  if (existsSync(dbPath)) { movedAside = `${dbPath}.before-restore-${stamp()}`; renameSync(dbPath, movedAside); }
  for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) renameSync(dbPath + ext, `${movedAside ?? dbPath}${ext}`);
  copyFileSync(backupFile, dbPath);
  return { movedAside, restored: verifyBackup(dbPath) };
}

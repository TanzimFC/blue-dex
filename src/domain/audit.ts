import type { Db } from '../db/database.js';

export function audit(db: Db, now: number, actorId: string, guildId: string | null, action: string, details: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO audit_log (at, actor_id, guild_id, action, details) VALUES (?,?,?,?,?)').run(now, actorId, guildId, action, JSON.stringify(details));
}

/** Record a failed reward/trade/etc. operation for later inspection. Never throws. */
export function recordFailure(db: Db, now: number, kind: string, ref: string | null, err: unknown): void {
  try {
    db.prepare('INSERT INTO failed_operations (at, kind, ref, error) VALUES (?,?,?,?)').run(now, kind, ref, String((err as Error)?.stack ?? err).slice(0, 2000));
  } catch { /* logging must never take the bot down */ }
}

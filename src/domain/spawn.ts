import type { Ctx } from '../context.js';
import type { Db } from '../db/database.js';
import { tx } from '../db/database.js';
import { CATCH_WINDOW_MS } from '../gameplay.js';
import type { Rarity, Variant } from '../types.js';
import { pickByRarity } from './pick.js';

export interface SpawnRow {
  id: string; guild_id: string; channel_id: string; message_id: string | null; character_id: string; card_definition_id: string;
  variant: Variant; started_at: number; expires_at: number; status: 'active' | 'caught' | 'expired' | 'void';
  catcher_id: string | null; caught_at: number | null; is_test: 0 | 1;
}

/** The ONLY data a spawn message is allowed to be built from. Deliberately has no variant field. */
export interface PublicSpawn { id: string; guildId: string; channelId: string; startedAt: number; expiresAt: number; spawnArtRef: string; isTest: boolean }

export type CreateSpawnResult =
  | { ok: true; spawn: SpawnRow; view: PublicSpawn }
  | { ok: false; reason: 'no_eligible_characters' | 'guild_has_active_spawn' | 'too_soon' | 'hourly_cap' | 'test_cooldown' };

interface TestOverrides { characterId?: string; variant?: Variant }

/** Create one spawn: exactly one character, exactly one variant, decided here on the server. */
export function createSpawn(ctx: Ctx, a: { guildId: string; channelId: string; isTest?: boolean; testOverrides?: TestOverrides }): CreateSpawnResult {
  const now = ctx.clock();
  const isTest = !!a.isTest;
  if (a.testOverrides && !isTest) throw new Error('overrides are only valid for test spawns');
  return tx(ctx.db, () => {
    const g = ctx.gameplay.spawn;
    if (!isTest) {
      const active = ctx.db.prepare("SELECT 1 FROM spawns WHERE guild_id=? AND is_test=0 AND status='active' AND expires_at > ?").get(a.guildId, now);
      if (active) return { ok: false, reason: 'guild_has_active_spawn' } as const;
      const last = ctx.db.prepare('SELECT MAX(started_at) AS t FROM spawns WHERE guild_id=? AND is_test=0 AND status <> ?').get(a.guildId, 'void') as { t: number | null };
      if (last.t !== null && now - last.t < g.minIntervalMs) return { ok: false, reason: 'too_soon' } as const;
      const hour = (ctx.db.prepare('SELECT COUNT(*) AS n FROM spawns WHERE guild_id=? AND is_test=0 AND started_at > ?').get(a.guildId, now - 3_600_000) as { n: number }).n;
      if (hour >= g.maxPerGuildPerHour) return { ok: false, reason: 'hourly_cap' } as const;
    } else {
      const recent = (ctx.db.prepare('SELECT COUNT(*) AS n FROM spawns WHERE guild_id=? AND is_test=1 AND started_at > ?').get(a.guildId, now - 60_000) as { n: number }).n;
      if (recent >= 3) return { ok: false, reason: 'test_cooldown' } as const;
    }
    const chars = ctx.db.prepare(`SELECT ch.id FROM characters ch JOIN spawn_assets sa ON sa.character_id=ch.id
      WHERE ch.status='active' AND EXISTS (SELECT 1 FROM card_definitions cd WHERE cd.character_id=ch.id AND cd.status='available')`).all() as { id: string }[];
    const forced = a.testOverrides?.characterId;
    const pool = forced ? chars.filter((c) => c.id === forced) : chars;
    if (!pool.length) return { ok: false, reason: 'no_eligible_characters' } as const;
    const character = pool[ctx.rng.int(pool.length)]!;
    const variant: Variant = a.testOverrides?.variant ?? (ctx.rng.float() < ctx.gameplay.shinySpawnOdds ? 'shiny' : 'normal');
    const defs = ctx.db.prepare("SELECT id, rarity FROM card_definitions WHERE character_id=? AND status='available'").all(character.id) as { id: string; rarity: Rarity }[];
    const def = pickByRarity(defs, ctx.gameplay.catchRarityWeights, ctx.rng);
    const id = ctx.rng.uuid();
    // Variant is persisted BEFORE anything is shown to players.
    ctx.db.prepare(`INSERT INTO spawns (id, guild_id, channel_id, character_id, card_definition_id, variant, started_at, expires_at, status, is_test)
      VALUES (?,?,?,?,?,?,?,?,'active',?)`).run(id, a.guildId, a.channelId, character.id, def.id, variant, now, now + CATCH_WINDOW_MS, isTest ? 1 : 0);
    const spawn = ctx.db.prepare('SELECT * FROM spawns WHERE id=?').get(id) as SpawnRow;
    return { ok: true, spawn, view: publicView(ctx.db, spawn) } as const;
  });
}

export function publicView(db: Db, s: SpawnRow): PublicSpawn {
  const art = db.prepare('SELECT normal_spawn_art, shiny_spawn_art FROM spawn_assets WHERE character_id=?').get(s.character_id) as { normal_spawn_art: string; shiny_spawn_art: string };
  return { id: s.id, guildId: s.guild_id, channelId: s.channel_id, startedAt: s.started_at, expiresAt: s.expires_at,
    spawnArtRef: s.variant === 'shiny' ? art.shiny_spawn_art : art.normal_spawn_art, isTest: !!s.is_test };
}

export function attachMessage(db: Db, spawnId: string, messageId: string): void {
  db.prepare('UPDATE spawns SET message_id=? WHERE id=?').run(messageId, spawnId);
}

/** Used when the Discord message could not be posted: nobody ever saw it, so nothing may be awarded. */
export function voidSpawn(db: Db, spawnId: string): void {
  db.prepare("UPDATE spawns SET status='void' WHERE id=? AND status='active'").run(spawnId);
}

/** Mark every active spawn whose deadline has passed (expires_at <= now) as expired. Returns what changed. */
export function expireDueSpawns(db: Db, now: number): SpawnRow[] {
  return tx(db, () => {
    const due = db.prepare("SELECT * FROM spawns WHERE status='active' AND expires_at <= ?").all(now) as SpawnRow[];
    db.prepare("UPDATE spawns SET status='expired' WHERE status='active' AND expires_at <= ?").run(now);
    return due;
  });
}

export interface RecoveryReport { expired: SpawnRow[]; voided: SpawnRow[]; resumed: SpawnRow[] }

/**
 * Startup recovery. Expired -> expired. Spawns whose timing cannot be trusted (start in the future => clock moved backwards)
 * -> void (never awards). Remaining active spawns are returned so timers can be re-armed.
 */
export function recoverSpawns(db: Db, now: number): RecoveryReport {
  return tx(db, () => {
    const expired = db.prepare("SELECT * FROM spawns WHERE status='active' AND expires_at <= ?").all(now) as SpawnRow[];
    db.prepare("UPDATE spawns SET status='expired' WHERE status='active' AND expires_at <= ?").run(now);
    const voided = db.prepare("SELECT * FROM spawns WHERE status='active' AND started_at > ?").all(now) as SpawnRow[];
    db.prepare("UPDATE spawns SET status='void' WHERE status='active' AND started_at > ?").run(now);
    const resumed = db.prepare("SELECT * FROM spawns WHERE status='active'").all() as SpawnRow[];
    return { expired, voided, resumed };
  });
}

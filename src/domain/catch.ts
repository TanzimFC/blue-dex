import type { Ctx } from '../context.js';
import { tx } from '../db/database.js';
import type { Rarity, Variant } from '../types.js';
import { normalizeAlias } from '../util/normalize.js';
import { ensureCollector, grantCopy } from './collection.js';
import type { GuessLimiter } from './limiter.js';
import type { SpawnRow } from './spawn.js';

export type CatchResult =
  | { ok: true; test: false; copyId: string; cardId: string; variant: Variant; characterId: string; firstEverCatch: boolean }
  | { ok: true; test: true; characterId: string; variant: Variant }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number }
  | { ok: false; reason: 'invalid' | 'wrong' | 'closed' | 'expired' | 'not_found' };

export interface CatchInput { spawnId: string; userId: string; username: string | null; guess: string }

/**
 * Process one guess. All authority comes from the database row and the server clock.
 * The state change is a single conditional UPDATE inside an IMMEDIATE transaction, so concurrent winners are impossible
 * (also across multiple connections/processes), and the CHECK constraints reject a catch at/after the deadline.
 */
export function attemptCatch(ctx: Ctx, limiter: GuessLimiter, input: CatchInput): CatchResult {
  const now = ctx.clock();
  const key = normalizeAlias(input.guess ?? '');
  if (!key) return { ok: false, reason: 'invalid' };

  const pre = ctx.db.prepare('SELECT guild_id FROM spawns WHERE id = ?').get(input.spawnId) as { guild_id: string } | undefined;
  if (!pre) return { ok: false, reason: 'not_found' };
  const verdict = limiter.check(input.userId, pre.guild_id, now);
  if (!verdict.allowed) return { ok: false, reason: 'rate_limited', retryAfterMs: verdict.retryAfterMs };

  const log = (result: string, detail: string | null = null) =>
    ctx.db.prepare('INSERT INTO catch_history (spawn_id, user_id, result, at, detail) VALUES (?,?,?,?,?)').run(input.spawnId, input.userId, result, now, detail);

  const result = tx(ctx.db, (): CatchResult => {
    const spawn = ctx.db.prepare('SELECT * FROM spawns WHERE id = ?').get(input.spawnId) as SpawnRow | undefined;
    if (!spawn) return { ok: false, reason: 'not_found' };
    if (spawn.status !== 'active') { log('closed', spawn.status); return { ok: false, reason: 'closed' }; }
    if (now < spawn.started_at) { // clock moved backwards: timing cannot be verified -> never award
      ctx.db.prepare("UPDATE spawns SET status='void' WHERE id=? AND status='active'").run(spawn.id);
      log('closed', 'unverifiable_clock');
      return { ok: false, reason: 'closed' };
    }
    if (now >= spawn.expires_at) {
      ctx.db.prepare("UPDATE spawns SET status='expired' WHERE id=? AND status='active'").run(spawn.id);
      log('expired');
      return { ok: false, reason: 'expired' };
    }
    const hit = ctx.db.prepare('SELECT character_id FROM character_aliases WHERE alias = ?').get(key) as { character_id: string } | undefined;
    if (!hit || hit.character_id !== spawn.character_id) { log('wrong', key.slice(0, 32)); return { ok: false, reason: 'wrong' }; }

    const won = ctx.db.prepare("UPDATE spawns SET status='caught', catcher_id=?, caught_at=? WHERE id=? AND status='active' AND expires_at > ?")
      .run(input.userId, now, spawn.id, now);
    if (won.changes !== 1) { log('closed', 'lost_race'); return { ok: false, reason: 'closed' }; }

    if (spawn.is_test) { log('test_success'); return { ok: true, test: true, characterId: spawn.character_id, variant: spawn.variant }; }

    const created = ensureCollector(ctx.db, input.userId, input.username, now);
    const copyId = grantCopy(ctx, { ownerId: input.userId, cardDefinitionId: spawn.card_definition_id, variant: spawn.variant, source: 'catch', sourceRef: spawn.id });
    ctx.db.prepare('UPDATE collectors SET total_catches = total_catches + 1, total_shiny_catches = total_shiny_catches + ? WHERE user_id = ?')
      .run(spawn.variant === 'shiny' ? 1 : 0, input.userId);
    log('success');
    return { ok: true, test: false, copyId, cardId: spawn.card_definition_id, variant: spawn.variant, characterId: spawn.character_id, firstEverCatch: created };
  });

  if (!result.ok && result.reason === 'wrong') limiter.recordWrong(input.userId, now);
  return result;
}
void (0 as unknown as Rarity);

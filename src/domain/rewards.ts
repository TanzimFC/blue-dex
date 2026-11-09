import type { Ctx } from '../context.js';
import { tx } from '../db/database.js';
import type { Rarity, Variant } from '../types.js';
import { nextUtcDayStart, nextUtcWeekStart, utcDayKey, utcWeekKey } from '../util/time.js';
import { ensureCollector, grantCopy } from './collection.js';
import { pickByRarity } from './pick.js';

export interface PackCard { copyId: string; cardId: string; variant: Variant }
export type ClaimResult =
  | { ok: true; periodKey: string; cards: PackCard[]; nextClaimAt: number; milestones: MilestoneGrant[] }
  | { ok: false; reason: 'already_claimed'; nextClaimAt: number };
export interface MilestoneGrant { questId: string; name: string; cards: PackCard[] }

/**
 * Pack odds come ONLY from trusted gameplay config (packRarityWeights / packShinyOdds). They are a separate mechanic
 * from spawn shiny odds. Must be called inside a transaction.
 */
function openPack(ctx: Ctx, userId: string, source: 'daily' | 'weekly' | 'milestone', ref: string, count: number): PackCard[] {
  const defs = ctx.db.prepare("SELECT id, rarity FROM card_definitions WHERE status='available' AND character_id IN (SELECT id FROM characters WHERE status='active')").all() as { id: string; rarity: Rarity }[];
  if (!defs.length) throw new Error('no available card definitions for pack');
  const out: PackCard[] = [];
  for (let i = 0; i < count; i++) {
    const def = pickByRarity(defs, ctx.gameplay.packRarityWeights, ctx.rng);
    const variant: Variant = ctx.rng.float() < ctx.gameplay.packShinyOdds ? 'shiny' : 'normal';
    const copyId = grantCopy(ctx, { ownerId: userId, cardDefinitionId: def.id, variant, source, sourceRef: `${ref}:${i}` });
    out.push({ copyId, cardId: def.id, variant });
  }
  return out;
}

export function periodInfo(type: 'daily' | 'weekly', now: number): { key: string; nextAt: number } {
  return type === 'daily' ? { key: utcDayKey(now), nextAt: nextUtcDayStart(now) } : { key: utcWeekKey(now), nextAt: nextUtcWeekStart(now) };
}

/** Idempotent: the UNIQUE(user, type, period) row is inserted first; only the call that inserts it may grant cards. */
export function claimPeriodic(ctx: Ctx, userId: string, username: string | null, type: 'daily' | 'weekly'): ClaimResult {
  const now = ctx.clock();
  const { key, nextAt } = periodInfo(type, now);
  const res = tx(ctx.db, (): ClaimResult => {
    ensureCollector(ctx.db, userId, username, now);
    const claimId = ctx.rng.uuid();
    const ins = ctx.db.prepare("INSERT INTO reward_claims (id, user_id, reward_type, period_key, claimed_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id, reward_type, period_key) DO NOTHING")
      .run(claimId, userId, type, key, now);
    if (ins.changes === 0) return { ok: false, reason: 'already_claimed', nextClaimAt: nextAt };
    const size = type === 'daily' ? ctx.gameplay.dailyPackSize : ctx.gameplay.weeklyPackSize;
    const cards = openPack(ctx, userId, type, claimId, size);
    ctx.db.prepare('UPDATE reward_claims SET detail = ? WHERE id = ?').run(JSON.stringify({ cards }), claimId);
    return { ok: true, periodKey: key, cards, nextClaimAt: nextAt, milestones: [] };
  });
  if (res.ok) res.milestones = evaluateMilestones(ctx, userId);
  return res;
}

/** Create quest rows: first catch, unique-card counts, and one "complete set" quest per set. Idempotent. */
export function seedQuests(ctx: Ctx): void {
  tx(ctx.db, () => {
    const up = ctx.db.prepare(`INSERT INTO quests (id,name,description,kind,target,set_id,reward_cards) VALUES (@id,@name,@description,@kind,@target,@set_id,@reward)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, kind=excluded.kind, target=excluded.target, set_id=excluded.set_id, reward_cards=excluded.reward_cards`);
    up.run({ id: 'first_catch', name: 'First Catch', description: 'Catch your first character.', kind: 'first_catch', target: 1, set_id: null, reward: 1 });
    up.run({ id: 'unique_5', name: 'Rookie Collector', description: 'Own 5 different cards at once.', kind: 'unique_cards', target: 5, set_id: null, reward: 1 });
    up.run({ id: 'unique_15', name: 'Squad Builder', description: 'Own 15 different cards at once.', kind: 'unique_cards', target: 15, set_id: null, reward: 2 });
    for (const s of ctx.db.prepare('SELECT id, name FROM sets').all() as { id: string; name: string }[]) {
      up.run({ id: `set_${s.id}`, name: `${s.name} Complete`, description: `Own every card in the ${s.name} set.`, kind: 'set_complete', target: 1, set_id: s.id, reward: 2 });
    }
  });
}

/**
 * Grant each newly completed milestone exactly once per player, ever. Progress is evaluated from CURRENT ownership,
 * but the grant is recorded permanently, so drop-and-regain cannot farm it. Milestones are also deduplicated by reward_claims UNIQUE.
 */
export function evaluateMilestones(ctx: Ctx, userId: string): MilestoneGrant[] {
  const now = ctx.clock();
  return tx(ctx.db, () => {
    const user = ctx.db.prepare('SELECT total_catches FROM collectors WHERE user_id=?').get(userId) as { total_catches: number } | undefined;
    if (!user) return [];
    const uniq = (ctx.db.prepare("SELECT COUNT(DISTINCT card_definition_id) n FROM owned_cards WHERE owner_id=?").get(userId) as { n: number }).n;
    const quests = ctx.db.prepare(`SELECT * FROM quests WHERE active=1 AND id NOT IN (SELECT quest_id FROM quest_progress WHERE user_id=?)`).all(userId) as
      { id: string; name: string; kind: string; target: number; set_id: string | null; reward_cards: number }[];
    const grants: MilestoneGrant[] = [];
    for (const q of quests) {
      let done = false;
      if (q.kind === 'first_catch') done = user.total_catches >= 1;
      else if (q.kind === 'unique_cards') done = uniq >= q.target;
      else if (q.kind === 'set_complete' && q.set_id) {
        const r = ctx.db.prepare(`SELECT COUNT(DISTINCT cd.id) AS total, COUNT(DISTINCT oc.card_definition_id) AS owned FROM card_definitions cd
          LEFT JOIN owned_cards oc ON oc.card_definition_id=cd.id AND oc.owner_id=? WHERE cd.set_id=? AND cd.status='available'`).get(userId, q.set_id) as { total: number; owned: number };
        done = r.total > 0 && r.owned === r.total;
      }
      if (!done) continue;
      const claimId = ctx.rng.uuid();
      const ins = ctx.db.prepare("INSERT INTO reward_claims (id,user_id,reward_type,period_key,claimed_at) VALUES (?,?,'milestone',?,?) ON CONFLICT(user_id,reward_type,period_key) DO NOTHING").run(claimId, userId, q.id, now);
      if (ins.changes === 0) continue;
      const cards = openPack(ctx, userId, 'milestone', claimId, q.reward_cards);
      ctx.db.prepare('UPDATE reward_claims SET detail=? WHERE id=?').run(JSON.stringify({ quest: q.id, cards }), claimId);
      ctx.db.prepare('INSERT INTO quest_progress (user_id, quest_id, completed_at, reward_claim_id) VALUES (?,?,?,?)').run(userId, q.id, now, claimId);
      grants.push({ questId: q.id, name: q.name, cards });
    }
    return grants;
  });
}

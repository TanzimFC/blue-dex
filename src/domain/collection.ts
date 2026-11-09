import type { Ctx } from '../context.js';
import type { Db } from '../db/database.js';
import { tx } from '../db/database.js';
import type { Rarity, Variant } from '../types.js';
import { normalizeCopyId } from '../util/normalize.js';

export type AcquireSource = 'catch' | 'daily' | 'weekly' | 'milestone' | 'admin_test';

/** Auto-create a collector on first valid gameplay interaction. Must run inside the caller's transaction when part of one. */
export function ensureCollector(db: Db, userId: string, username: string | null, now: number): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO collectors (user_id, created_at, username) VALUES (?,?,?)').run(userId, now, username);
  if (r.changes === 0 && username) db.prepare('UPDATE collectors SET username = ? WHERE user_id = ?').run(username, userId);
  return r.changes === 1;
}

/**
 * Create one new owned copy with a fresh unique ID. MUST be called inside a transaction.
 * `(source, sourceRef)` is unique in the DB so a retried catch/reward can never mint a second copy.
 */
export function grantCopy(ctx: Ctx, a: { ownerId: string; cardDefinitionId: string; variant: Variant; source: AcquireSource; sourceRef?: string | null }): string {
  const exists = ctx.db.prepare('SELECT 1 FROM owned_cards WHERE id = ?');
  let id = '';
  for (let i = 0; i < 10; i++) {
    id = ctx.rng.shortId(8);
    if (!exists.get(id)) break;
    if (i === 9) throw new Error('could not allocate unique copy id');
  }
  const now = ctx.clock();
  ctx.db.prepare(`INSERT INTO owned_cards (id, owner_id, card_definition_id, variant, acquired_at, source, source_ref) VALUES (?,?,?,?,?,?,?)`)
    .run(id, a.ownerId, a.cardDefinitionId, a.variant, now, a.source, a.sourceRef ?? null);
  ctx.db.prepare(`INSERT INTO card_events (at, copy_id, event, to_user, card_definition_id, variant, ref) VALUES (?,?,?,?,?,?,?)`)
    .run(now, id, 'acquired', a.ownerId, a.cardDefinitionId, a.variant, `${a.source}:${a.sourceRef ?? ''}`);
  return id;
}

export interface OwnedCardView {
  copy_id: string; owner_id: string; variant: Variant; locked: 0 | 1; favorited: 0 | 1; acquired_at: number;
  state: 'owned' | 'reserved'; reserved_trade_id: string | null; source: string;
  card_id: string; edition_name: string; rarity: Rarity; set_id: string; set_name: string; display_stats: string;
  normal_card_art: string; shiny_card_art: string; character_id: string; character_name: string;
}

const OWNED_SELECT = `
SELECT oc.id AS copy_id, oc.owner_id, oc.variant, oc.locked, oc.favorited, oc.acquired_at, oc.state, oc.reserved_trade_id, oc.source,
  cd.id AS card_id, cd.edition_name, cd.rarity, cd.set_id, s.name AS set_name, cd.display_stats, cd.normal_card_art, cd.shiny_card_art,
  ch.id AS character_id, ch.display_name AS character_name
FROM owned_cards oc
JOIN card_definitions cd ON cd.id = oc.card_definition_id
JOIN sets s ON s.id = cd.set_id
JOIN characters ch ON ch.id = cd.character_id`;

export function getOwnedCard(db: Db, copyIdRaw: string): OwnedCardView | undefined {
  return db.prepare(`${OWNED_SELECT} WHERE oc.id = ?`).get(normalizeCopyId(copyIdRaw)) as OwnedCardView | undefined;
}

export function getOwnedCardFor(db: Db, userId: string, copyIdRaw: string): OwnedCardView | undefined {
  const c = getOwnedCard(db, copyIdRaw);
  return c && c.owner_id === userId ? c : undefined;
}

const RARITY_ORDER = `CASE cd.rarity WHEN 'legendary' THEN 5 WHEN 'epic' THEN 4 WHEN 'rare' THEN 3 WHEN 'uncommon' THEN 2 ELSE 1 END`;
export type ListSort = 'recent' | 'rarity' | 'name' | 'variant';
export interface ListFilter {
  characterId?: string; rarity?: Rarity; setId?: string; variant?: Variant; search?: string;
  lockedOnly?: boolean; favoritedOnly?: boolean; sort?: ListSort; page?: number; pageSize?: number;
}

export function listOwned(db: Db, userId: string, f: ListFilter = {}): { rows: OwnedCardView[]; total: number; page: number; pages: number } {
  const where: string[] = ['oc.owner_id = @uid'];
  const p: Record<string, unknown> = { uid: userId };
  if (f.characterId) { where.push('cd.character_id = @ch'); p.ch = f.characterId; }
  if (f.rarity) { where.push('cd.rarity = @ra'); p.ra = f.rarity; }
  if (f.setId) { where.push('cd.set_id = @se'); p.se = f.setId; }
  if (f.variant) { where.push('oc.variant = @va'); p.va = f.variant; }
  if (f.search) { where.push('(instr(lower(ch.display_name), lower(@q)) > 0 OR instr(lower(cd.edition_name), lower(@q)) > 0 OR oc.id = upper(@q))'); p.q = f.search.slice(0, 64); }
  if (f.lockedOnly) where.push('oc.locked = 1');
  if (f.favoritedOnly) where.push('oc.favorited = 1');
  const order = {
    recent: 'oc.acquired_at DESC, oc.id',
    rarity: `${RARITY_ORDER} DESC, ch.display_name, oc.id`,
    name: 'ch.display_name, cd.edition_name, oc.variant, oc.id',
    variant: "oc.variant DESC, ch.display_name, oc.id",
  }[f.sort ?? 'recent'];
  const pageSize = Math.min(Math.max(f.pageSize ?? 10, 1), 25);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM owned_cards oc JOIN card_definitions cd ON cd.id=oc.card_definition_id JOIN characters ch ON ch.id=cd.character_id WHERE ${where.join(' AND ')}`).get(p) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(f.page ?? 1, 1), pages);
  const rows = db.prepare(`${OWNED_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT @lim OFFSET @off`).all({ ...p, lim: pageSize, off: (page - 1) * pageSize }) as OwnedCardView[];
  return { rows, total, page, pages };
}

export interface ProfileStats {
  userId: string; username: string | null; createdAt: number; profilePublic: boolean;
  uniqueOwned: number; totalCopies: number; shinyCopies: number; uniqueShiny: number;
  catalogueSize: number; completionPct: number; totalCatches: number; totalShinyCatches: number;
}

/** Current-ownership statistics. Lifetime catch counters are reported separately and never feed completion. */
export function getProfileStats(db: Db, userId: string): ProfileStats | undefined {
  const c = db.prepare('SELECT * FROM collectors WHERE user_id = ?').get(userId) as
    | { user_id: string; username: string | null; created_at: number; profile_public: number; total_catches: number; total_shiny_catches: number } | undefined;
  if (!c) return undefined;
  const o = db.prepare(`
    SELECT COUNT(*) AS copies,
           COALESCE(SUM(oc.variant='shiny'),0) AS shiny,
           COUNT(DISTINCT oc.card_definition_id) AS uniq,
           COUNT(DISTINCT CASE WHEN oc.variant='shiny' THEN oc.card_definition_id END) AS uniq_shiny,
           COUNT(DISTINCT CASE WHEN cd.status='available' THEN oc.card_definition_id END) AS uniq_avail
    FROM owned_cards oc JOIN card_definitions cd ON cd.id = oc.card_definition_id WHERE oc.owner_id = ?`).get(userId) as
    { copies: number; shiny: number; uniq: number; uniq_shiny: number; uniq_avail: number };
  const size = (db.prepare("SELECT COUNT(*) AS n FROM card_definitions WHERE status='available'").get() as { n: number }).n;
  return {
    userId, username: c.username, createdAt: c.created_at, profilePublic: !!c.profile_public,
    uniqueOwned: o.uniq, totalCopies: o.copies, shinyCopies: o.shiny, uniqueShiny: o.uniq_shiny,
    catalogueSize: size, completionPct: size ? Math.round((o.uniq_avail / size) * 1000) / 10 : 0,
    totalCatches: c.total_catches, totalShinyCatches: c.total_shiny_catches,
  };
}

export interface DexEntry {
  card_id: string; edition_name: string; rarity: Rarity; set_id: string; set_name: string; character_id: string; character_name: string;
  status: string; normal_card_art: string; shiny_card_art: string; owned_normal: number; owned_shiny: number;
}
export interface DexFilter { characterId?: string; rarity?: Rarity; setId?: string; search?: string; show?: 'all' | 'owned' | 'missing' | 'shiny'; page?: number; pageSize?: number }

export function dexPage(db: Db, userId: string, f: DexFilter = {}): { rows: DexEntry[]; total: number; page: number; pages: number } {
  const where: string[] = ["cd.status = 'available'"];
  const p: Record<string, unknown> = { uid: userId };
  if (f.characterId) { where.push('cd.character_id = @ch'); p.ch = f.characterId; }
  if (f.rarity) { where.push('cd.rarity = @ra'); p.ra = f.rarity; }
  if (f.setId) { where.push('cd.set_id = @se'); p.se = f.setId; }
  if (f.search) { where.push('(instr(lower(ch.display_name), lower(@q)) > 0 OR instr(lower(cd.edition_name), lower(@q)) > 0)'); p.q = f.search.slice(0, 64); }
  const having = { all: '', owned: 'HAVING owned_normal + owned_shiny > 0', missing: 'HAVING owned_normal + owned_shiny = 0', shiny: 'HAVING owned_shiny > 0' }[f.show ?? 'all'];
  const base = `FROM card_definitions cd JOIN sets s ON s.id=cd.set_id JOIN characters ch ON ch.id=cd.character_id
    LEFT JOIN owned_cards oc ON oc.card_definition_id = cd.id AND oc.owner_id = @uid
    WHERE ${where.join(' AND ')} GROUP BY cd.id
    ${having}`;
  const sel = `SELECT cd.id AS card_id, cd.edition_name, cd.rarity, cd.set_id, s.name AS set_name, ch.id AS character_id, ch.display_name AS character_name,
    cd.status, cd.normal_card_art, cd.shiny_card_art,
    COALESCE(SUM(oc.variant='normal'),0) AS owned_normal, COALESCE(SUM(oc.variant='shiny'),0) AS owned_shiny`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${sel} ${base})`).get(p) as { n: number }).n;
  const pageSize = Math.min(Math.max(f.pageSize ?? 8, 1), 25);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(f.page ?? 1, 1), pages);
  const rows = db.prepare(`${sel} ${base} ORDER BY ch.display_name, cd.id LIMIT @lim OFFSET @off`).all({ ...p, lim: pageSize, off: (page - 1) * pageSize }) as DexEntry[];
  return { rows, total, page, pages };
}

export function setLocked(db: Db, userId: string, copyId: string, locked: boolean): boolean {
  return db.prepare('UPDATE owned_cards SET locked = ? WHERE id = ? AND owner_id = ?').run(locked ? 1 : 0, normalizeCopyId(copyId), userId).changes === 1;
}
export function setFavorited(db: Db, userId: string, copyId: string, fav: boolean): boolean {
  return db.prepare('UPDATE owned_cards SET favorited = ? WHERE id = ? AND owner_id = ?').run(fav ? 1 : 0, normalizeCopyId(copyId), userId).changes === 1;
}

export type DropResult =
  | { ok: true; card: OwnedCardView; copiesRemaining: number; leftCollection: boolean }
  | { ok: false; reason: 'not_found' | 'locked' | 'reserved' };

/** Read-only preview shown before the player confirms. */
export function previewDrop(db: Db, userId: string, copyId: string): { ok: true; card: OwnedCardView; otherCopies: number } | { ok: false; reason: DropResult extends infer R ? (R extends { ok: false; reason: infer X } ? X : never) : never } {
  const card = getOwnedCardFor(db, userId, copyId);
  if (!card) return { ok: false, reason: 'not_found' };
  if (card.locked) return { ok: false, reason: 'locked' };
  if (card.state === 'reserved') return { ok: false, reason: 'reserved' };
  const n = (db.prepare('SELECT COUNT(*) AS n FROM owned_cards WHERE owner_id=? AND card_definition_id=? AND id<>?').get(userId, card.card_id, card.copy_id) as { n: number }).n;
  return { ok: true, card, otherCopies: n };
}

/**
 * Permanently discard ONE specific copy. Ownership and lock state are re-verified inside the transaction, and the DELETE itself
 * is conditional, so replays/double-clicks cannot discard anything else. The copy is not transferred, re-spawned, or compensated.
 */
export function confirmDrop(ctx: Ctx, userId: string, copyIdRaw: string): DropResult {
  const copyId = normalizeCopyId(copyIdRaw);
  return tx(ctx.db, () => {
    const card = getOwnedCardFor(ctx.db, userId, copyId);
    if (!card) return { ok: false, reason: 'not_found' } as const;
    if (card.locked) return { ok: false, reason: 'locked' } as const;
    if (card.state === 'reserved') return { ok: false, reason: 'reserved' } as const;
    const del = ctx.db.prepare("DELETE FROM owned_cards WHERE id = ? AND owner_id = ? AND locked = 0 AND state = 'owned'").run(copyId, userId);
    if (del.changes !== 1) return { ok: false, reason: 'not_found' } as const;
    ctx.db.prepare(`INSERT INTO card_events (at, copy_id, event, from_user, card_definition_id, variant, ref) VALUES (?,?,?,?,?,?,?)`)
      .run(ctx.clock(), copyId, 'dropped', userId, card.card_id, card.variant, 'user_drop');
    const remaining = (ctx.db.prepare('SELECT COUNT(*) AS n FROM owned_cards WHERE owner_id=? AND card_definition_id=?').get(userId, card.card_id) as { n: number }).n;
    return { ok: true, card, copiesRemaining: remaining, leftCollection: remaining === 0 } as const;
  });
}

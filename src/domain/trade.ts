import type { Ctx } from '../context.js';
import type { Db } from '../db/database.js';
import { tx } from '../db/database.js';
import { recordFailure } from './audit.js';
import { normalizeCopyId } from '../util/normalize.js';

/**
 * Trade state model
 *   pending   : proposer's OFFER copies are reserved (owned_cards.state='reserved', reserved_trade_id=trade).
 *   accepted  : recipient accepted; recipient's REQUESTED copies are now reserved too.
 *   completed : proposer confirmed; all copies swapped atomically, reservations cleared.
 *   declined / cancelled / expired / failed : every reservation released.
 * A reserved copy cannot be dropped, offered elsewhere, or reserved by another trade (conditional UPDATE ... WHERE state='owned').
 */
export type TradeStatus = 'pending' | 'accepted' | 'completed' | 'declined' | 'cancelled' | 'expired' | 'failed';
export interface TradeRow { id: string; proposer_id: string; recipient_id: string; status: TradeStatus; created_at: number; expires_at: number; accepted_at: number | null; completed_at: number | null; failure_reason: string | null }
export interface TradeItem { trade_id: string; copy_id: string; original_owner_id: string; side: 'offer' | 'request'; card_definition_id: string; variant: string }
export type TradeError = 'self_trade' | 'recipient_unknown' | 'empty_offer' | 'too_many_items' | 'duplicate_items' | 'not_owner' | 'ineligible' | 'too_many_pending' | 'not_found' | 'forbidden' | 'bad_state' | 'expired' | 'revalidation_failed';
export type TradeResult<T = object> = ({ ok: true } & T) | { ok: false; reason: TradeError; detail?: string };

const MAX_OUTGOING_PENDING = 3;

const getTrade = (db: Db, id: string) => db.prepare('SELECT * FROM trades WHERE id=?').get(id) as TradeRow | undefined;
export const getTradeView = (db: Db, id: string) => {
  const trade = getTrade(db, id);
  if (!trade) return undefined;
  const items = db.prepare(`SELECT ti.*, cd.edition_name, cd.rarity, ch.display_name AS character_name FROM trade_items ti
    JOIN card_definitions cd ON cd.id=ti.card_definition_id JOIN characters ch ON ch.id=cd.character_id WHERE ti.trade_id=? ORDER BY ti.side, ti.copy_id`).all(id) as
    (TradeItem & { edition_name: string; rarity: string; character_name: string })[];
  return { trade, items };
};

interface CardState { id: string; owner_id: string; state: string; locked: number; reserved_trade_id: string | null; card_definition_id: string; variant: string }
const card = (db: Db, id: string) => db.prepare('SELECT id, owner_id, state, locked, reserved_trade_id, card_definition_id, variant FROM owned_cards WHERE id=?').get(id) as CardState | undefined;

function releaseAll(db: Db, tradeId: string): void {
  db.prepare("UPDATE owned_cards SET state='owned', reserved_trade_id=NULL WHERE reserved_trade_id=?").run(tradeId);
}
function close(db: Db, tradeId: string, status: TradeStatus, from: TradeStatus[], reason?: string): boolean {
  const r = db.prepare(`UPDATE trades SET status=?, failure_reason=COALESCE(?,failure_reason) WHERE id=? AND status IN (${from.map(() => '?').join(',')})`).run(status, reason ?? null, tradeId, ...from);
  if (r.changes === 1) releaseAll(db, tradeId);
  return r.changes === 1;
}

export function proposeTrade(ctx: Ctx, a: { proposerId: string; recipientId: string; offerCopyIds: string[]; requestCopyIds: string[] }): TradeResult<{ tradeId: string }> {
  const now = ctx.clock();
  const offer = a.offerCopyIds.map(normalizeCopyId), request = a.requestCopyIds.map(normalizeCopyId);
  if (a.proposerId === a.recipientId) return { ok: false, reason: 'self_trade' };
  if (!offer.length) return { ok: false, reason: 'empty_offer' };
  const max = ctx.gameplay.trade.maxItemsPerSide;
  if (offer.length > max || request.length > max) return { ok: false, reason: 'too_many_items' };
  if (new Set([...offer, ...request]).size !== offer.length + request.length) return { ok: false, reason: 'duplicate_items' };
  return tx(ctx.db, (): TradeResult<{ tradeId: string }> => {
    if (!ctx.db.prepare('SELECT 1 FROM collectors WHERE user_id=?').get(a.recipientId) || !ctx.db.prepare('SELECT 1 FROM collectors WHERE user_id=?').get(a.proposerId)) return { ok: false, reason: 'recipient_unknown' };
    const pending = (ctx.db.prepare("SELECT COUNT(*) n FROM trades WHERE proposer_id=? AND status IN ('pending','accepted') AND expires_at > ?").get(a.proposerId, now) as { n: number }).n;
    if (pending >= MAX_OUTGOING_PENDING) return { ok: false, reason: 'too_many_pending' };
    for (const [ids, owner] of [[offer, a.proposerId], [request, a.recipientId]] as const) {
      for (const id of ids) {
        const c = card(ctx.db, id);
        if (!c || c.owner_id !== owner) return { ok: false, reason: 'not_owner', detail: id };
        if (c.locked || c.state !== 'owned') return { ok: false, reason: 'ineligible', detail: id };
      }
    }
    const tradeId = ctx.rng.uuid();
    ctx.db.prepare("INSERT INTO trades (id, proposer_id, recipient_id, status, created_at, expires_at) VALUES (?,?,?,'pending',?,?)").run(tradeId, a.proposerId, a.recipientId, now, now + ctx.gameplay.trade.expiryMs);
    const ins = ctx.db.prepare('INSERT INTO trade_items (trade_id, copy_id, original_owner_id, side, card_definition_id, variant) VALUES (?,?,?,?,?,?)');
    const reserve = ctx.db.prepare("UPDATE owned_cards SET state='reserved', reserved_trade_id=? WHERE id=? AND owner_id=? AND state='owned' AND locked=0");
    for (const id of offer) {
      const c = card(ctx.db, id)!;
      ins.run(tradeId, id, a.proposerId, 'offer', c.card_definition_id, c.variant);
      if (reserve.run(tradeId, id, a.proposerId).changes !== 1) throw new Error('reserve failed'); // rolls back the whole proposal
    }
    for (const id of request) {
      const c = card(ctx.db, id)!;
      ins.run(tradeId, id, a.recipientId, 'request', c.card_definition_id, c.variant);
    }
    return { ok: true, tradeId };
  });
}

/** Lazily expire one trade if its time has passed. Must be inside a tx. */
function expireIfDue(ctx: Ctx, t: TradeRow): boolean {
  if ((t.status === 'pending' || t.status === 'accepted') && ctx.clock() >= t.expires_at) { close(ctx.db, t.id, 'expired', ['pending', 'accepted']); return true; }
  return false;
}

/** Recipient accepts after reviewing both sides. Reserves the recipient's requested copies. */
export function acceptTrade(ctx: Ctx, tradeId: string, userId: string): TradeResult {
  return tx(ctx.db, (): TradeResult => {
    const t = getTrade(ctx.db, tradeId);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.recipient_id !== userId) return { ok: false, reason: 'forbidden' };
    if (expireIfDue(ctx, t)) return { ok: false, reason: 'expired' };
    if (t.status !== 'pending') return { ok: false, reason: 'bad_state' };
    const items = ctx.db.prepare('SELECT * FROM trade_items WHERE trade_id=?').all(tradeId) as TradeItem[];
    for (const it of items) {
      const c = card(ctx.db, it.copy_id);
      const ok = c && c.owner_id === it.original_owner_id && c.locked === 0 && (it.side === 'offer' ? c.state === 'reserved' && c.reserved_trade_id === tradeId : c.state === 'owned');
      if (!ok) { close(ctx.db, tradeId, 'failed', ['pending'], `accept_revalidation:${it.copy_id}`); return { ok: false, reason: 'revalidation_failed', detail: it.copy_id }; }
    }
    const reserve = ctx.db.prepare("UPDATE owned_cards SET state='reserved', reserved_trade_id=? WHERE id=? AND owner_id=? AND state='owned' AND locked=0");
    for (const it of items.filter((i) => i.side === 'request')) {
      if (reserve.run(tradeId, it.copy_id, it.original_owner_id).changes !== 1) throw new Error('reserve failed');
    }
    ctx.db.prepare("UPDATE trades SET status='accepted', accepted_at=? WHERE id=? AND status='pending'").run(ctx.clock(), tradeId);
    return { ok: true };
  });
}

/** Proposer's final confirmation. Revalidates everything, then swaps ALL copies or NONE inside one transaction. */
export function confirmTrade(ctx: Ctx, tradeId: string, userId: string): TradeResult {
  let outcome: TradeResult;
  try {
    outcome = tx(ctx.db, (): TradeResult => {
      const t = getTrade(ctx.db, tradeId);
      if (!t) return { ok: false, reason: 'not_found' };
      if (t.proposer_id !== userId) return { ok: false, reason: 'forbidden' };
      if (expireIfDue(ctx, t)) return { ok: false, reason: 'expired' };
      if (t.status !== 'accepted') return { ok: false, reason: 'bad_state' }; // replays land here
      const items = ctx.db.prepare('SELECT * FROM trade_items WHERE trade_id=?').all(tradeId) as TradeItem[];
      for (const it of items) {
        const c = card(ctx.db, it.copy_id);
        if (!c || c.owner_id !== it.original_owner_id || c.state !== 'reserved' || c.reserved_trade_id !== tradeId || c.locked !== 0) {
          close(ctx.db, tradeId, 'failed', ['accepted'], `revalidation:${it.copy_id}`);
          return { ok: false, reason: 'revalidation_failed', detail: it.copy_id };
        }
      }
      const now = ctx.clock();
      const move = ctx.db.prepare("UPDATE owned_cards SET owner_id=?, state='owned', reserved_trade_id=NULL, favorited=0 WHERE id=? AND owner_id=? AND state='reserved' AND reserved_trade_id=? AND locked=0");
      const ev = ctx.db.prepare("INSERT INTO card_events (at, copy_id, event, from_user, to_user, card_definition_id, variant, ref) VALUES (?,?,'transferred',?,?,?,?,?)");
      for (const it of items) {
        const to = it.original_owner_id === t.proposer_id ? t.recipient_id : t.proposer_id;
        if (move.run(to, it.copy_id, it.original_owner_id, tradeId).changes !== 1) throw new Error(`transfer failed for ${it.copy_id}`); // rolls back everything
        ev.run(now, it.copy_id, it.original_owner_id, to, it.card_definition_id, it.variant, `trade:${tradeId}`);
      }
      const done = ctx.db.prepare("UPDATE trades SET status='completed', completed_at=? WHERE id=? AND status='accepted'").run(now, tradeId);
      if (done.changes !== 1) throw new Error('trade status changed concurrently');
      return { ok: true };
    });
  } catch (e) {
    // Whole transaction rolled back: nothing moved. Release reservations and mark failed in a fresh short tx.
    recordFailure(ctx.db, ctx.clock(), 'trade_confirm', tradeId, e);
    tx(ctx.db, () => close(ctx.db, tradeId, 'failed', ['pending', 'accepted'], 'exception'));
    return { ok: false, reason: 'revalidation_failed', detail: 'internal_error' };
  }
  return outcome;
}

export function declineTrade(ctx: Ctx, tradeId: string, userId: string): TradeResult {
  return tx(ctx.db, (): TradeResult => {
    const t = getTrade(ctx.db, tradeId);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.recipient_id !== userId) return { ok: false, reason: 'forbidden' };
    return close(ctx.db, tradeId, 'declined', ['pending', 'accepted']) ? { ok: true } : { ok: false, reason: 'bad_state' };
  });
}
export function cancelTrade(ctx: Ctx, tradeId: string, userId: string): TradeResult {
  return tx(ctx.db, (): TradeResult => {
    const t = getTrade(ctx.db, tradeId);
    if (!t) return { ok: false, reason: 'not_found' };
    if (t.proposer_id !== userId) return { ok: false, reason: 'forbidden' };
    return close(ctx.db, tradeId, 'cancelled', ['pending', 'accepted']) ? { ok: true } : { ok: false, reason: 'bad_state' };
  });
}
/** Periodic sweep + startup recovery. Releases reservations for every overdue trade. */
export function expireTrades(ctx: Ctx): number {
  return tx(ctx.db, () => {
    const due = ctx.db.prepare("SELECT id FROM trades WHERE status IN ('pending','accepted') AND expires_at <= ?").all(ctx.clock()) as { id: string }[];
    for (const d of due) close(ctx.db, d.id, 'expired', ['pending', 'accepted']);
    return due.length;
  });
}

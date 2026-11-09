import type { Db } from '../db/database.js';

export type Board = 'unique' | 'completion' | 'shiny' | 'score';

/**
 * Collection score (documented in docs/GAMEPLAY.md): for every DISTINCT card currently owned,
 * common=1, uncommon=2, rare=4, epic=8, legendary=16; plus +2 for every distinct card owned in shiny.
 * Duplicates never add score. Nothing here can be bought.
 */
export const SCORE_SQL = `SUM(CASE cd.rarity WHEN 'legendary' THEN 16 WHEN 'epic' THEN 8 WHEN 'rare' THEN 4 WHEN 'uncommon' THEN 2 ELSE 1 END)`;

export interface BoardRow { rank: number; userId: string; username: string | null; value: number }

export function leaderboard(db: Db, board: Board, limit = 10): BoardRow[] {
  const size = (db.prepare("SELECT COUNT(*) n FROM card_definitions WHERE status='available'").get() as { n: number }).n || 1;
  const base = `
    SELECT c.user_id AS user_id, c.username AS username,
      COUNT(DISTINCT d.def) AS uniq,
      COUNT(DISTINCT CASE WHEN d.shiny=1 THEN d.def END) AS uniq_shiny,
      COALESCE(SUM(d.pts),0) + 2*COUNT(DISTINCT CASE WHEN d.shiny=1 THEN d.def END) AS score
    FROM collectors c
    JOIN (SELECT oc.owner_id AS owner, oc.card_definition_id AS def, MAX(oc.variant='shiny') AS shiny,
            (CASE cd.rarity WHEN 'legendary' THEN 16 WHEN 'epic' THEN 8 WHEN 'rare' THEN 4 WHEN 'uncommon' THEN 2 ELSE 1 END) AS pts
          FROM owned_cards oc JOIN card_definitions cd ON cd.id=oc.card_definition_id
          WHERE cd.status='available' GROUP BY oc.owner_id, oc.card_definition_id) d ON d.owner = c.user_id
    WHERE c.profile_public = 1
    GROUP BY c.user_id`;
  const col = { unique: 'uniq', completion: 'uniq', shiny: 'uniq_shiny', score: 'score' }[board];
  const rows = db.prepare(`SELECT * FROM (${base}) ORDER BY ${col} DESC, user_id LIMIT ?`).all(Math.min(Math.max(limit, 1), 25)) as
    { user_id: string; username: string | null; uniq: number; uniq_shiny: number; score: number }[];
  return rows.map((r, i) => ({
    rank: i + 1, userId: r.user_id, username: r.username,
    value: board === 'completion' ? Math.round((r.uniq / size) * 1000) / 10 : board === 'unique' ? r.uniq : board === 'shiny' ? r.uniq_shiny : r.score,
  }));
}
void (0 as unknown);

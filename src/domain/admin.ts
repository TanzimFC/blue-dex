import type { Ctx } from '../context.js';
import { tx } from '../db/database.js';
import { audit } from './audit.js';
import { ensureCollector, grantCopy } from './collection.js';
import type { Variant } from '../types.js';

/**
 * The ONLY keys a server administrator may change. Spawn rates, intervals, shiny odds, rarity odds and reward amounts are
 * deliberately absent: they live in trusted bot config and there is no code path from Discord to them.
 */
export const GUILD_SETTING_ALLOWLIST = ['spawn_channel_id', 'spawns_enabled', 'compact_embeds'] as const;
export type GuildSettingKey = (typeof GUILD_SETTING_ALLOWLIST)[number];

export interface Actor { userId: string; isGuildAdmin: boolean; isOperator: boolean }
export type SettingResult = { ok: true } | { ok: false; reason: 'forbidden' | 'unknown_setting' | 'invalid_value' };

export function updateGuildSetting(ctx: Ctx, actor: Actor, guildId: string, key: string, value: unknown): SettingResult {
  if (!actor.isGuildAdmin && !actor.isOperator) return { ok: false, reason: 'forbidden' };
  if (!(GUILD_SETTING_ALLOWLIST as readonly string[]).includes(key)) return { ok: false, reason: 'unknown_setting' };
  let stored: string | number;
  if (key === 'spawn_channel_id') { if (typeof value !== 'string' || !/^\d{5,25}$/.test(value)) return { ok: false, reason: 'invalid_value' }; stored = value; }
  else { if (typeof value !== 'boolean') return { ok: false, reason: 'invalid_value' }; stored = value ? 1 : 0; }
  const now = ctx.clock();
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id, updated_at) VALUES (?,?)').run(guildId, now);
    // key is allow-listed above, so interpolating the column name is safe.
    ctx.db.prepare(`UPDATE guild_settings SET ${key} = ?, updated_at = ?, updated_by = ? WHERE guild_id = ?`).run(stored, now, actor.userId, guildId);
    audit(ctx.db, now, actor.userId, guildId, 'guild_setting_changed', { key, value: stored });
  });
  return { ok: true };
}

export function getGuildSettings(ctx: Ctx, guildId: string) {
  return ctx.db.prepare('SELECT * FROM guild_settings WHERE guild_id=?').get(guildId) as
    { guild_id: string; spawn_channel_id: string | null; spawns_enabled: number; compact_embeds: number; updated_at: number; updated_by: string | null } | undefined;
}

export type TestSpawnAuth = { ok: true; mayOverride: boolean } | { ok: false };
/** Admins may trigger a plain test spawn in their own server; only operators may force character/variant. */
export function authorizeTestSpawn(actor: Actor): TestSpawnAuth {
  if (actor.isOperator) return { ok: true, mayOverride: true };
  if (actor.isGuildAdmin) return { ok: true, mayOverride: false };
  return { ok: false };
}

/** Operator-only grant of clearly labelled test cards (source='admin_test'), audited. Exposed via CLI only, never a Discord command. */
export function adminGrantTestCard(ctx: Ctx, operatorId: string, userId: string, cardDefinitionId: string, variant: Variant, reason: string): string {
  return tx(ctx.db, () => {
    ensureCollector(ctx.db, userId, null, ctx.clock());
    const id = grantCopy(ctx, { ownerId: userId, cardDefinitionId, variant, source: 'admin_test', sourceRef: `grant:${ctx.rng.uuid()}` });
    audit(ctx.db, ctx.clock(), operatorId, null, 'admin_grant_test_card', { userId, cardDefinitionId, variant, copyId: id, reason });
    return id;
  });
}
/** Remove erroneous test cards (only source='admin_test', never reserved ones). Audited. */
export function adminRemoveTestCards(ctx: Ctx, operatorId: string, userId: string, reason: string): number {
  return tx(ctx.db, () => {
    const rows = ctx.db.prepare("SELECT id, card_definition_id, variant FROM owned_cards WHERE owner_id=? AND source='admin_test' AND state='owned'").all(userId) as { id: string; card_definition_id: string; variant: string }[];
    for (const r of rows) {
      ctx.db.prepare('DELETE FROM owned_cards WHERE id=?').run(r.id);
      ctx.db.prepare("INSERT INTO card_events (at, copy_id, event, from_user, card_definition_id, variant, ref) VALUES (?,?,'admin_removed',?,?,?,'admin_test_cleanup')").run(ctx.clock(), r.id, userId, r.card_definition_id, r.variant);
    }
    audit(ctx.db, ctx.clock(), operatorId, null, 'admin_remove_test_cards', { userId, count: rows.length, ids: rows.map((r) => r.id), reason });
    return rows.length;
  });
}

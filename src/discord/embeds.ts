import { EmbedBuilder } from 'discord.js';
import type { OwnedCardView, DexEntry, ListSort } from '../domain/collection.js';
import type { Rarity, Variant } from '../types.js';
import { artParts, resolveArt } from './art.js';

export const RARITY_STYLE: Record<Rarity, { color: number; label: string; emoji: string }> = {
  common: { color: 0x9aa5b1, label: 'Common', emoji: '⚪' },
  uncommon: { color: 0x3cb371, label: 'Uncommon', emoji: '🟢' },
  rare: { color: 0x3b82f6, label: 'Rare', emoji: '🔵' },
  epic: { color: 0x9b59b6, label: 'Epic', emoji: '🟣' },
  legendary: { color: 0xf5a623, label: 'Legendary', emoji: '🟠' },
};
export const SHINY_COLOR = 0xffd700;
export const BRAND_COLOR = 0x2b6cb0;
export const variantTag = (v: Variant) => (v === 'shiny' ? '✨ Shiny' : 'Normal');
export const copyRef = (id: string) => `\`#${id}\``;

export interface CardLike { card_id: string; edition_name: string; rarity: Rarity; set_name: string; character_name: string; normal_card_art: string; shiny_card_art: string; display_stats?: string }

/** Standard card embed. Shiny treatment is applied ONLY here (post-catch / owned views), never to spawn messages. */
export function cardEmbed(c: CardLike, variant: Variant, assetsDir: string, opts: { compact?: boolean; extra?: string[]; title?: string } = {}) {
  const style = RARITY_STYLE[c.rarity];
  const art = resolveArt(variant === 'shiny' ? c.shiny_card_art : c.normal_card_art, assetsDir);
  const parts = artParts(art, 'card.png');
  const e = new EmbedBuilder()
    .setColor(variant === 'shiny' ? SHINY_COLOR : style.color)
    .setTitle(opts.title ?? `${variant === 'shiny' ? '✨ ' : ''}${c.character_name}`)
    .setDescription([`**${c.edition_name}**`, `${style.emoji} ${style.label} · ${c.set_name} · ${variantTag(variant)}`, ...(opts.extra ?? [])].join('\n'));
  if (c.display_stats) {
    try {
      const s = JSON.parse(c.display_stats) as Record<string, string | number>;
      const f = Object.entries(s).slice(0, 6).map(([k, v]) => ({ name: k, value: String(v), inline: true }));
      if (f.length) e.addFields(f);
    } catch { /* ignore malformed display stats */ }
  }
  if (parts.imageUrl) (opts.compact ? e.setThumbnail(parts.imageUrl) : e.setImage(parts.imageUrl));
  else e.setFooter({ text: 'Artwork unavailable' }); // graceful fallback
  return { embed: e, files: parts.file ? [parts.file] : [] };
}

export function ownedLine(c: OwnedCardView): string {
  const flags = `${c.locked ? ' 🔒' : ''}${c.favorited ? ' ⭐' : ''}${c.state === 'reserved' ? ' 🔁' : ''}`;
  return `${copyRef(c.copy_id)} ${c.variant === 'shiny' ? '✨' : '▫️'} **${c.character_name}** · ${c.edition_name} · ${RARITY_STYLE[c.rarity].emoji}${flags}`;
}
export function dexLine(r: DexEntry): string {
  const own = r.owned_normal + r.owned_shiny;
  const mark = own ? '✅' : '▫️';
  const have = own ? ` — owned ×${own}${r.owned_shiny ? ` (✨${r.owned_shiny})` : ''}` : ' — *not owned*';
  return `${mark} \`${r.card_id}\` **${r.character_name}** · ${r.edition_name} · ${RARITY_STYLE[r.rarity].emoji}${have}`;
}
export const SORT_LABEL: Record<ListSort, string> = { recent: 'Newest', rarity: 'Rarity', name: 'Name', variant: 'Variant' };

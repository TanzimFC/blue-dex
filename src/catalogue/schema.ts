import { z } from 'zod';
import { RARITIES } from '../types.js';
import { normalizeAlias } from '../util/normalize.js';

const id = z.string().regex(/^[a-z0-9_]{1,48}$/, 'ids are lowercase a-z, 0-9, underscore');
/** Asset ref: absolute https URL, or `file:` path relative to ASSETS_DIR. */
const assetRef = z.string().refine((s) => /^https:\/\/\S+$/.test(s) || /^file:[A-Za-z0-9_./-]+$/.test(s) && !s.includes('..'), 'must be https:// URL or file:relative/path');

export const characterSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  aliases: z.array(z.string().min(1).max(64)).max(20).default([]),
  status: z.enum(['active', 'retired']).default('active'),
  spawnArt: z.object({ normal: assetRef, shiny: assetRef }),
});
export const setSchema = z.object({ id, name: z.string().min(1).max(64) });
export const cardSchema = z.object({
  id,
  characterId: id,
  edition: z.string().min(1).max(64),
  rarity: z.enum(RARITIES),
  setId: id,
  stats: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  art: z.object({ normal: assetRef, shiny: assetRef }),
  available: z.boolean().default(true),
});
export const cardsFileSchema = z.object({ sets: z.array(setSchema), cards: z.array(cardSchema) });

export type CatalogueCharacter = z.infer<typeof characterSchema>;
export type CatalogueCard = z.infer<typeof cardSchema>;
export interface Catalogue { characters: CatalogueCharacter[]; sets: z.infer<typeof setSchema>[]; cards: CatalogueCard[] }

export class CatalogueError extends Error {
  constructor(public problems: string[]) {
    super('Invalid catalogue:\n - ' + problems.join('\n - '));
  }
}

/** Parse + cross-validate. Collects every problem rather than failing on the first. */
export function validateCatalogue(rawCharacters: unknown, rawCards: unknown): Catalogue {
  const problems: string[] = [];
  const chars = z.array(characterSchema).safeParse(rawCharacters);
  const cards = cardsFileSchema.safeParse(rawCards);
  if (!chars.success) problems.push(...chars.error.issues.map((i) => `characters.json ${i.path.join('.')}: ${i.message}`));
  if (!cards.success) problems.push(...cards.error.issues.map((i) => `cards.json ${i.path.join('.')}: ${i.message}`));
  if (!chars.success || !cards.success) throw new CatalogueError(problems);

  const seen = (label: string, ids: string[]) => {
    const s = new Set<string>();
    for (const x of ids) { if (s.has(x)) problems.push(`duplicate ${label} id "${x}"`); s.add(x); }
  };
  seen('character', chars.data.map((c) => c.id));
  seen('set', cards.data.sets.map((s) => s.id));
  seen('card', cards.data.cards.map((c) => c.id));

  // Ambiguous aliases must never resolve to two characters.
  const owner = new Map<string, string>();
  for (const c of chars.data) {
    for (const a of [c.name, ...c.aliases]) {
      const key = normalizeAlias(a);
      if (!key) { problems.push(`character ${c.id}: alias "${a}" normalises to empty`); continue; }
      const prev = owner.get(key);
      if (prev && prev !== c.id) problems.push(`ambiguous alias "${a}" (key "${key}") used by both ${prev} and ${c.id}`);
      owner.set(key, c.id);
    }
    // Spawn art must not leak the variant through its URL.
    for (const [kind, ref] of [['normal', c.spawnArt.normal], ['shiny', c.spawnArt.shiny]] as const) {
      if (ref.startsWith('https://') && /shiny|normal/i.test(ref)) {
        problems.push(`character ${c.id}: ${kind} spawn art URL must be opaque (must not contain "shiny" or "normal"): ${ref}`);
      }
    }
  }
  const charIds = new Set(chars.data.map((c) => c.id));
  const setIds = new Set(cards.data.sets.map((s) => s.id));
  for (const card of cards.data.cards) {
    if (!charIds.has(card.characterId)) problems.push(`card ${card.id}: unknown characterId ${card.characterId}`);
    if (!setIds.has(card.setId)) problems.push(`card ${card.id}: unknown setId ${card.setId}`);
  }
  if (problems.length) throw new CatalogueError(problems);
  return { characters: chars.data, sets: cards.data.sets, cards: cards.data.cards };
}

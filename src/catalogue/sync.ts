import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/database.js';
import { tx } from '../db/database.js';
import { normalizeAlias } from '../util/normalize.js';
import { validateCatalogue, type Catalogue } from './schema.js';

export function loadCatalogueFiles(dir: string): Catalogue {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return validateCatalogue(read('characters.json'), read('cards.json'));
}

/**
 * Idempotently mirror the catalogue files into the DB.
 * Nothing is ever hard-deleted: owned copies reference card definitions, so removed entries become
 * 'unavailable' / 'retired' instead.
 */
export function syncCatalogue(db: Db, cat: Catalogue): void {
  tx(db, () => {
    const upChar = db.prepare(`INSERT INTO characters (id, display_name, status) VALUES (@id,@name,@status)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, status=excluded.status`);
    const upAsset = db.prepare(`INSERT INTO spawn_assets (character_id, normal_spawn_art, shiny_spawn_art) VALUES (?,?,?)
      ON CONFLICT(character_id) DO UPDATE SET normal_spawn_art=excluded.normal_spawn_art, shiny_spawn_art=excluded.shiny_spawn_art`);
    const delAliases = db.prepare('DELETE FROM character_aliases WHERE character_id = ?');
    const insAlias = db.prepare('INSERT OR IGNORE INTO character_aliases (alias, character_id) VALUES (?,?)');
    for (const c of cat.characters) {
      upChar.run({ id: c.id, name: c.name, status: c.status });
      upAsset.run(c.id, c.spawnArt.normal, c.spawnArt.shiny);
      delAliases.run(c.id);
    }
    // Insert after all deletes so an alias moved between characters in one edit works.
    for (const c of cat.characters) for (const a of [c.name, ...c.aliases]) insAlias.run(normalizeAlias(a), c.id);
    const ids = cat.characters.map((c) => c.id);
    db.prepare(`UPDATE characters SET status='retired' WHERE id NOT IN (${ids.map(() => '?').join(',') || "''"})`).run(...ids);

    const upSet = db.prepare('INSERT INTO sets (id, name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
    for (const s of cat.sets) upSet.run(s.id, s.name);
    const upCard = db.prepare(`INSERT INTO card_definitions (id, character_id, edition_name, rarity, set_id, display_stats, normal_card_art, shiny_card_art, status)
      VALUES (@id,@characterId,@edition,@rarity,@setId,@stats,@normal,@shiny,@status)
      ON CONFLICT(id) DO UPDATE SET character_id=excluded.character_id, edition_name=excluded.edition_name, rarity=excluded.rarity,
        set_id=excluded.set_id, display_stats=excluded.display_stats, normal_card_art=excluded.normal_card_art,
        shiny_card_art=excluded.shiny_card_art, status=excluded.status`);
    for (const c of cat.cards) {
      upCard.run({ id: c.id, characterId: c.characterId, edition: c.edition, rarity: c.rarity, setId: c.setId, stats: JSON.stringify(c.stats),
        normal: c.art.normal, shiny: c.art.shiny, status: c.available ? 'available' : 'unavailable' });
    }
    const cids = cat.cards.map((c) => c.id);
    db.prepare(`UPDATE card_definitions SET status='unavailable' WHERE id NOT IN (${cids.map(() => '?').join(',') || "''"})`).run(...cids);
  });
}

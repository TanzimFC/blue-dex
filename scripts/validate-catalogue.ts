import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';
import { resolveArt } from '../src/discord/art.js';

const dir = process.env.CATALOGUE_DIR ?? './catalogue';
const assets = process.env.ASSETS_DIR ?? './assets';
try {
  const c = loadCatalogueFiles(dir);
  console.log(`catalogue OK: ${c.characters.length} characters, ${c.sets.length} sets, ${c.cards.length} cards`);
  let missing = 0;
  const check = (label: string, ref: string) => { if (resolveArt(ref, assets).kind === 'missing') { missing++; console.warn(`  missing art: ${label} -> ${ref}`); } };
  for (const ch of c.characters) { check(`${ch.id} spawn normal`, ch.spawnArt.normal); check(`${ch.id} spawn shiny`, ch.spawnArt.shiny); }
  for (const cd of c.cards) { check(`${cd.id} card normal`, cd.art.normal); check(`${cd.id} card shiny`, cd.art.shiny); }
  console.log(missing ? `WARNING: ${missing} art files missing (the bot degrades gracefully; missing SPAWN art voids that spawn)` : 'all art present');
  void existsSync; void join;
} catch (e) { console.error((e as Error).message); process.exit(1); }

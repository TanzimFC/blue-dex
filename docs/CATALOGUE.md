# Catalogue format and art conventions

Files in `CATALOGUE_DIR` (default `./catalogue`) are validated (`npm run catalogue:validate`) and synced into the DB at every start.
Nothing is hard-deleted: removed cards become `unavailable`, removed characters `retired`, so owned copies never dangle.

## characters.json
```json
{ "id": "isagi_yoichi", "name": "Isagi Yoichi", "aliases": ["Isagi", "Yoichi"],
  "spawnArt": { "normal": "file:spawn/isagi_spawn_normal.png", "shiny": "file:spawn/isagi_spawn_shiny.png" } }
```
- `id`: stable, `[a-z0-9_]`, never reuse. `name` is also an accepted alias.
- Aliases are normalised (lower-case, accents/punctuation/spaces removed). The same normalised alias on two characters is a **validation error**;
  the DB primary key on `character_aliases.alias` enforces it too.

## cards.json
```json
{ "sets": [{ "id": "genesis", "name": "Genesis" }],
  "cards": [{ "id": "isagi_001", "characterId": "isagi_yoichi", "edition": "Awakened Eye", "rarity": "rare", "setId": "genesis",
             "stats": { "Position": "Forward" },
             "art": { "normal": "file:cards/isagi_card_001_normal.png", "shiny": "file:cards/isagi_card_001_shiny.png" } }] }
```
A character may have many cards (editions/series). `stats` are display-only. `rarity`: common|uncommon|rare|epic|legendary. `"available": false` hides a card from new drops.

## Art references
`https://…` (stable CDN) or `file:relative/path` (under `ASSETS_DIR`, attached by the bot).

| Asset | Purpose | Never used for |
|---|---|---|
| `spawnArt.normal` / `spawnArt.shiny` | the "who's that?" image in the spawn message | cards, /card, /list |
| `art.normal` / `art.shiny` (card) | collectible card art in /card, catch result, packs | spawn messages |

Rules for spawn art: the two images must have the **same dimensions and no badge/label/sparkle that reveals shininess**
(the variation should be the character's alternate colouring itself). Local files are always attached as `spawn.png`;
for `https` refs use **opaque** URLs — validation rejects URLs containing "shiny" or "normal".
Recommended sizes: spawn 512×512, card 400×560 (identical across variants of the same asset type).
Missing art never crashes a command: card views show a "Artwork unavailable" footer; a spawn whose art is missing is voided and logged.
Only use original or properly licensed artwork. Do not imply affiliation with Blue Lock or its rights holders.
`assets/` currently holds generated flat-colour **placeholders** (`npx tsx scripts/make-placeholders.ts`).

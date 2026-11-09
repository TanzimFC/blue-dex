# Blue Dex (working name)

A Discord bot for collecting character cards: timed spawns, secret shiny variants, collections, daily/weekly packs, safe trading.
TypeScript · Node 20+ · discord.js 14 · SQLite (better-sqlite3, WAL). One process, one VPS.
Unofficial fan project; not affiliated with Blue Lock, its creators or publishers.

## Layout
```
src/domain/      all game rules (spawn, catch, collection, rewards, trade, admin). No Discord imports. Fully unit-tested.
src/db/          connection pragmas, tx helper, versioned migrations (src/db/migrations.ts)
src/catalogue/   JSON schema validation + idempotent sync
src/discord/     slash commands, handlers, spawner/scheduler, embeds, health check
src/ops/         backup/restore
scripts/         register-commands, backup, restore, restore-test, ops CLI, load-test, validate-catalogue
deploy/          systemd service + backup timer
docs/            GAMEPLAY.md (rules/config/admin surface), CATALOGUE.md (data + art), RELEASE_CHECKLIST.md
```
Storage is isolated behind `Db` + the `domain/` modules so a PostgreSQL port only touches `src/db` and the SQL in `src/domain`.

## Develop
```bash
npm ci
npx tsx scripts/make-placeholders.ts     # placeholder art (replace before launch)
npm test                                 # 68 automated tests
npm run typecheck
cp .env.example .env                     # fill DISCORD_TOKEN, DISCORD_CLIENT_ID, OPERATOR_IDS
npm run commands:register                # set DEV_GUILD_ID for instant guild-scoped registration
npm run dev
```

## Deploy on a clean Ubuntu VPS (1 GB)
1. Discord Developer Portal: create the application + bot. **Intents:** no privileged intents are needed (no Server Members, no Message Content);
   the bot uses only `Guilds` and `GuildMessages`. Invite with scopes `bot applications.commands` and permissions
   View Channels, Send Messages, Embed Links, Attach Files.
2. Server: `sudo apt install -y nodejs npm build-essential python3` (Node ≥ 20; use NodeSource for a current LTS), `sudo useradd -r -m bluedex`.
3. `sudo mkdir /opt/bluedex && sudo chown bluedex /opt/bluedex`, copy the project there (as `bluedex`):
   `npm ci && npm run build && npm prune --omit=dev` (keep `tsx` out of production; `build` produces `dist/`).
4. `cp .env.example .env && chmod 600 .env`, fill secrets. **Secrets live only in `.env`/the service environment, never in git.**
   `DATABASE_PATH` must be on persistent local disk (default `/opt/bluedex/data`).
5. Put real art in `assets/` (or https URLs in the catalogue); `npm run catalogue:validate`.
6. Register commands once per change: `npm run commands:register` (idempotent bulk overwrite; global propagation can take up to an hour).
7. `sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/ && sudo systemctl daemon-reload`
   `sudo systemctl enable --now bluedex bluedex-backup.timer`
8. Check: `curl -s localhost:8787/healthz` → `{"ok":true,...}`; `journalctl -u bluedex -f` (structured JSON logs).

Never run two bot processes against one database file. Updating: stop → pull/build → start (a pre-migration snapshot of the DB file is
written automatically if a migration is pending; the bot refuses to run on a DB schema newer than the code).
`systemctl stop` triggers graceful shutdown (timers cleared, gateway closed, WAL checkpointed). On start, expired spawns are marked expired,
unverifiable ones voided, live ones re-armed, and overdue trades released.

## Backups and restore
- Automatic: `bluedex-backup.timer` runs every 6 h → `backups/bluedex-<UTC stamp>.db` (SQLite online backup API, safe while running,
  `integrity_check` verified, last `BACKUP_KEEP` kept). Copy `backups/` off the VPS (rclone/rsync) — a backup on the same disk is not a disaster backup.
- Restore: `sudo systemctl stop bluedex` → `npm run db:restore -- backups/<file>` (refuses a failed integrity check; the current DB is moved aside, not deleted) →
  `sudo systemctl start bluedex`.
- **Prove it before trusting it:** `npm run db:restore-test` builds a realistic DB, backs it up during concurrent writes, destroys the original,
  restores, and compares a content digest (exit 0 only if all checks pass). Run it on the VPS, and also do one manual restore of a real backup into a scratch path.

## Operations
`npm run ops -- failed | audit | trade <id> | history <copyId> | grant-test … | remove-test …` (shell access only; see script header).
Troubleshooting: spawn not appearing → `/settings view`, bot permissions in the channel, `journalctl` for `spawn skipped`/`spawn art missing`
(a spawn with missing art is voided and logged in `failed_operations`); command missing → re-run `commands:register`;
"database is locked" → another process has the DB open; health 503 → check `discord`/`db` flags in the JSON.
Load check on the target box: `GUILDS=300 RACERS=20 npm run load-test` (use `tsx`; keep dev deps on a staging checkout) and watch `rssMB`.

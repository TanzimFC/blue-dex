/**
 * Restore exercise. Builds a realistic DB (catches, drops, a completed trade, rewards), backs it up while a second
 * connection keeps writing, DESTROYS the original, restores, and proves the data is identical.
 * Exit code 0 only if every check passes. Run: npm run db:restore-test
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { loadCatalogueFiles, syncCatalogue } from '../src/catalogue/sync.js';
import { defaultGameplay } from '../src/gameplay.js';
import { seededRng, systemRng } from '../src/util/rng.js';
import { createSpawn } from '../src/domain/spawn.js';
import { attemptCatch } from '../src/domain/catch.js';
import { GuessLimiter } from '../src/domain/limiter.js';
import { claimPeriodic, seedQuests } from '../src/domain/rewards.js';
import { proposeTrade, acceptTrade, confirmTrade } from '../src/domain/trade.js';
import { confirmDrop, listOwned } from '../src/domain/collection.js';
import { backupDatabase, restoreDatabase } from '../src/ops/backup.js';
import type { Ctx } from '../src/context.js';

const dir = mkdtempSync(join(tmpdir(), 'bd-restore-'));
const dbPath = join(dir, 'live.db');
let now = Date.UTC(2026, 9, 30, 12);
const gp = { ...defaultGameplay, spawn: { ...defaultGameplay.spawn, minIntervalMs: 0, maxPerGuildPerHour: 1000 } };
const mk = (db: Db): Ctx => ({ db, clock: () => now, rng: seededRng(11), gameplay: gp });
const checks: [string, boolean][] = [];
const ok = (name: string, v: boolean) => { checks.push([name, v]); console.log(`${v ? 'PASS' : 'FAIL'}  ${name}`); };
const digest = (db: Db) => {
  const h = createHash('sha256');
  for (const t of ['collectors', 'owned_cards', 'spawns', 'catch_history', 'reward_claims', 'trades', 'trade_items', 'card_events', 'quest_progress'])
    h.update(t + JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1,2`).all()));
  return h.digest('hex');
};

let db = openDb(dbPath); migrate(db); syncCatalogue(db, loadCatalogueFiles('catalogue'));
const ctx = mk(db); seedQuests(ctx);
const lim = new GuessLimiter({ ...gp.guess, minGapMs: 0 });
const users = ['1001', '1002', '1003', '1004'];
for (let n = 0; n < 40; n++) {
  now += 200_000;
  const s = createSpawn(ctx, { guildId: 'g' + (n % 3), channelId: 'c' }); if (!s.ok) continue;
  const name = (db.prepare('SELECT display_name n FROM characters WHERE id=?').get(s.spawn.character_id) as { n: string }).n;
  attemptCatch(ctx, lim, { spawnId: s.spawn.id, userId: users[n % 4]!, username: 'u', guess: name });
}
for (const u of users) { claimPeriodic(ctx, u, 'u', 'daily'); claimPeriodic(ctx, u, 'u', 'weekly'); }
const a = listOwned(db, '1001', { pageSize: 25 }).rows, b = listOwned(db, '1002', { pageSize: 25 }).rows;
const t = proposeTrade(ctx, { proposerId: '1001', recipientId: '1002', offerCopyIds: [a[0]!.copy_id], requestCopyIds: [b[0]!.copy_id] });
if (t.ok) { acceptTrade(ctx, t.tradeId, '1002'); confirmTrade(ctx, t.tradeId, '1001'); }
confirmDrop(ctx, '1003', listOwned(db, '1003').rows[0]!.copy_id);

// A concurrent writer keeps committing while the backup runs (online backup must stay consistent).
const writer = openDb(dbPath); const wctx = mk(writer);
const writing = setInterval(() => { now += 1000; claimPeriodic(wctx, 'w' + Math.floor(now / 1000), 'w', 'daily'); }, 5);
const info = await backupDatabase(dbPath, join(dir, 'backups'), 5);
clearInterval(writing); writer.close();
ok('backup passes integrity_check', info.integrity === 'ok');
ok('backup records schema version', info.schemaVersion === 1);

// Disaster: take a final snapshot of the true state, then destroy the live DB completely.
const finalInfo = await backupDatabase(dbPath, join(dir, 'backups'), 5);
const before = digest(db);
const countBefore = (db.prepare('SELECT COUNT(*) n FROM owned_cards').get() as { n: number }).n;
db.close();
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(f, { force: true });
ok('live database destroyed', !existsSync(dbPath));

const res = restoreDatabase(finalInfo.file, dbPath);
ok('restore passes integrity_check', res.restored.integrity === 'ok');
db = openDb(dbPath);
ok('restored DB is at expected schema, migrate is a no-op', migrate(db).from === 1);
ok('restored data digest is identical to pre-disaster state', digest(db) === before);
ok('card count identical', (db.prepare('SELECT COUNT(*) n FROM owned_cards').get() as { n: number }).n === countBefore);
ok('foreign keys intact', (db.pragma('foreign_key_check') as unknown[]).length === 0);
const rctx: Ctx = { ...mk(db), rng: systemRng };
const again = claimPeriodic(rctx, '1001', 'u', 'daily');
ok('idempotency state survived: daily still cannot be re-claimed', !again.ok);
const s2 = createSpawn(rctx, { guildId: 'new', channelId: 'c' });
ok('bot can keep operating on restored DB', s2.ok);
db.close(); rmSync(dir, { recursive: true, force: true });
const failed = checks.filter(([, v]) => !v);
console.log(failed.length ? `\nRESTORE TEST FAILED (${failed.length})` : `\nRESTORE TEST PASSED (${checks.length}/${checks.length})`);
process.exit(failed.length ? 1 : 0);

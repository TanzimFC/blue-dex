/**
 * Burst/concurrency harness. Measures event-loop delay, DB latency, RSS and error counts under:
 *  - many guilds with simultaneous spawns and many players racing for each
 *  - bursts of /list-style reads and claim writes
 * NOTE: numbers are only meaningful when run ON THE TARGET VPS. Run: npm run load-test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openDb } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { loadCatalogueFiles, syncCatalogue } from '../src/catalogue/sync.js';
import { defaultGameplay } from '../src/gameplay.js';
import { systemRng } from '../src/util/rng.js';
import { createSpawn } from '../src/domain/spawn.js';
import { attemptCatch } from '../src/domain/catch.js';
import { GuessLimiter } from '../src/domain/limiter.js';
import { claimPeriodic } from '../src/domain/rewards.js';
import { listOwned, dexPage, getProfileStats } from '../src/domain/collection.js';
import { leaderboard } from '../src/domain/leaderboard.js';

const GUILDS = Number(process.env.GUILDS ?? 300), PLAYERS_PER_SPAWN = Number(process.env.RACERS ?? 20), READS = Number(process.env.READS ?? 5000);
const dir = mkdtempSync(join(tmpdir(), 'bd-load-'));
const db = openDb(join(dir, 'load.db')); migrate(db); syncCatalogue(db, loadCatalogueFiles('catalogue'));
const ctx = { db, clock: Date.now, rng: systemRng, gameplay: { ...defaultGameplay, spawn: { ...defaultGameplay.spawn, minIntervalMs: 0, maxPerGuildPerHour: 100 } } };
const lim = new GuessLimiter({ ...defaultGameplay.guess, minGapMs: 0, guildMaxPerWindow: 1e9, maxWrongPerWindow: 1e9 });
const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
const lat: number[] = []; let errors = 0, wins = 0, doubleWins = 0;
const time = <T>(f: () => T): T => { const t = performance.now(); try { return f(); } catch (e) { errors++; throw e; } finally { lat.push(performance.now() - t); } };
const tick = () => new Promise((r) => setImmediate(r));
const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
const t0 = performance.now();

for (let g = 0; g < GUILDS; g++) {
  const s = time(() => createSpawn(ctx, { guildId: `g${g}`, channelId: 'c' }));
  if (!s.ok) { errors++; continue; }
  const name = (db.prepare('SELECT display_name n FROM characters WHERE id=?').get(s.spawn.character_id) as { n: string }).n;
  let w = 0;
  for (let p = 0; p < PLAYERS_PER_SPAWN; p++) {
    const r = time(() => attemptCatch(ctx, lim, { spawnId: s.spawn.id, userId: String(1_000_000 + g * 1000 + p), username: 'u', guess: p % 3 === 0 ? name : 'wrong' + p }));
    if (r.ok) w++;
    if (p % 4 === 3) await tick(); // interleave like real interaction arrival
  }
  wins += w; if (w > 1) doubleWins++;
  await tick();
}
for (let i = 0; i < READS; i++) {
  const u = String(1_000_000 + (i % GUILDS) * 1000);
  time(() => { listOwned(db, u, { pageSize: 10 }); dexPage(db, u, {}); getProfileStats(db, u); });
  if (i % 250 === 0) time(() => leaderboard(db, 'score', 10));
  if (i % 5 === 0) time(() => claimPeriodic(ctx, u, 'u', 'daily'));
  if (i % 4 === 0) await tick();
}
h.disable();
const secs = (performance.now() - t0) / 1000;
const owned = (db.prepare('SELECT COUNT(*) n FROM owned_cards').get() as { n: number }).n;
const dup = (db.prepare("SELECT COUNT(*) n FROM (SELECT source_ref FROM owned_cards WHERE source='catch' GROUP BY source_ref HAVING COUNT(*)>1)").get() as { n: number }).n;
console.log(JSON.stringify({
  note: 'run on the target VPS for capacity claims', guilds: GUILDS, racersPerSpawn: PLAYERS_PER_SPAWN, ops: lat.length, seconds: +secs.toFixed(2),
  opsPerSec: Math.round(lat.length / secs), dbOpLatencyMs: { p50: +pct(lat, 0.5).toFixed(3), p99: +pct(lat, 0.99).toFixed(3), max: +Math.max(...lat).toFixed(2) },
  eventLoopDelayMs: { p50: +(h.percentile(50) / 1e6).toFixed(2), p99: +(h.percentile(99) / 1e6).toFixed(2), max: +(h.max / 1e6).toFixed(2) },
  rssMB: Math.round(process.memoryUsage().rss / 1048576), heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  errors, catchWins: wins, spawnsWithMultipleWinners: doubleWins, duplicateCatchCards: dup, cardsOwned: owned, dbFileMB: +(db.pragma('page_count', { simple: true }) as number * (db.pragma('page_size', { simple: true }) as number) / 1048576).toFixed(2),
}, null, 2));
db.close(); rmSync(dir, { recursive: true, force: true });
process.exit(errors || doubleWins || dup ? 1 : 0);

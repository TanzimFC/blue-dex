import 'dotenv/config';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadEnv } from './env.js';
import { makeLogger } from './logger.js';
import { openDb } from './db/database.js';
import { currentVersion, migrate } from './db/migrate.js';
import { migrations } from './db/migrations.js';
import { loadCatalogueFiles, syncCatalogue } from './catalogue/sync.js';
import { gameplayFromEnv } from './gameplay.js';
import { systemRng } from './util/rng.js';
import { seedQuests } from './domain/rewards.js';
import { expireTrades } from './domain/trade.js';
import { GuessLimiter } from './domain/limiter.js';
import { Spawner } from './discord/spawner.js';
import { handleInteraction, type App } from './discord/handlers.js';
import { startHealth } from './discord/health.js';
import type { Ctx } from './context.js';

const env = loadEnv();
const log = makeLogger(env.LOG_LEVEL);
const db = openDb(env.DATABASE_PATH);

// Safety net: snapshot the DB file before applying a pending migration.
const pending = migrations.some((m) => m.version > currentVersion(db));
if (pending && existsSync(env.DATABASE_PATH) && statSync(env.DATABASE_PATH).size > 0) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const snap = `${env.DATABASE_PATH}.pre-migrate-${Date.now()}`;
  copyFileSync(env.DATABASE_PATH, snap);
  log.info({ snap }, 'pre-migration snapshot written');
}
log.info(migrate(db), 'migrations applied');
syncCatalogue(db, loadCatalogueFiles(env.CATALOGUE_DIR));

const ctx: Ctx = { db, clock: Date.now, rng: systemRng, gameplay: gameplayFromEnv(process.env) };
seedQuests(ctx);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages], allowedMentions: { parse: [] } });
const spawner = new Spawner(ctx, client, env.ASSETS_DIR, log);
const app: App = { ctx, env, client, spawner, limiter: new GuessLimiter(ctx.gameplay.guess), log };

client.on(Events.InteractionCreate, (i) => void handleInteraction(app, i));
client.on(Events.MessageCreate, (m) => { if (m.guildId && !m.author.bot) spawner.onActivity(m.guildId, m.channelId); });
client.on(Events.Error, (e) => log.error({ err: e }, 'discord client error'));
client.on(Events.ShardDisconnect, (ev, id) => log.warn({ code: ev.code, shard: id }, 'shard disconnected'));
process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandledRejection'));

const sweep = setInterval(() => {
  try { const n = expireTrades(ctx); if (n) log.info({ n }, 'expired trades released'); } catch (e) { log.error({ err: e }, 'trade sweep failed'); }
}, 60_000);

let health: ReturnType<typeof startHealth>;
client.once(Events.ClientReady, (c) => {
  log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'ready');
  expireTrades(ctx); // trade recovery after restart
  spawner.start(); // spawn recovery after restart
  health = startHealth(env.HEALTH_PORT, client, db);
});

let closing = false;
async function shutdown(sig: string): Promise<void> {
  if (closing) return; closing = true;
  log.info({ sig }, 'shutting down');
  clearInterval(sweep); spawner.stop(); health?.close();
  try { await client.destroy(); } catch { /* ignore */ }
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { log.error({ err: e }, 'db close failed'); }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await client.login(env.DISCORD_TOKEN);

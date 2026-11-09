import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import type { Db } from '../db/database.js';

/** Liveness/readiness on 127.0.0.1 only. 200 when Discord gateway is READY and the DB answers; 503 otherwise. */
export function startHealth(port: number, client: Client, db: Db): Server | undefined {
  if (!port) return undefined;
  const srv = createServer((req, res) => {
    if (req.url !== '/healthz') { res.statusCode = 404; return void res.end(); }
    let dbOk = false;
    try { dbOk = (db.prepare('SELECT 1 AS x').get() as { x: number }).x === 1; } catch { /* reported below */ }
    const discordOk = client.isReady() && client.ws.status === 0;
    res.statusCode = dbOk && discordOk ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: dbOk && discordOk, discord: discordOk, db: dbOk, pingMs: client.ws.ping, uptimeS: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

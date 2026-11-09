/**
 * Operator CLI (needs shell access to the host, so it is NOT a Discord-reachable exploit surface).
 *   npm run ops -- failed                        list unresolved failed operations
 *   npm run ops -- resolve <id>                  mark a failed operation resolved
 *   npm run ops -- audit [n]                     recent audit log
 *   npm run ops -- trade <tradeId>               inspect a trade and its items
 *   npm run ops -- history <copyId>              provenance of a card copy
 *   npm run ops -- grant-test <userId> <cardId> <normal|shiny> <reason...>
 *   npm run ops -- remove-test <userId> <reason...>
 */
import 'dotenv/config';
import { openDb } from '../src/db/database.js';
import { loadPaths } from '../src/env.js';
import { systemRng } from '../src/util/rng.js';
import { defaultGameplay } from '../src/gameplay.js';
import { adminGrantTestCard, adminRemoveTestCards } from '../src/domain/admin.js';

const db = openDb(loadPaths().dbPath);
const ctx = { db, clock: Date.now, rng: systemRng, gameplay: defaultGameplay };
const who = `operator:${process.env.USER ?? 'cli'}`;
const [cmd, ...a] = process.argv.slice(2);
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
switch (cmd) {
  case 'failed': show(db.prepare('SELECT * FROM failed_operations WHERE resolved=0 ORDER BY id DESC LIMIT 50').all()); break;
  case 'resolve': db.prepare('UPDATE failed_operations SET resolved=1 WHERE id=?').run(Number(a[0])); console.log('ok'); break;
  case 'audit': show(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(a[0] ?? 25))); break;
  case 'trade': show({ trade: db.prepare('SELECT * FROM trades WHERE id=?').get(a[0]), items: db.prepare('SELECT * FROM trade_items WHERE trade_id=?').all(a[0]) }); break;
  case 'history': show(db.prepare('SELECT * FROM card_events WHERE copy_id=? ORDER BY id').all((a[0] ?? '').toUpperCase())); break;
  case 'grant-test': console.log('granted copy', adminGrantTestCard(ctx, who, a[0]!, a[1]!, a[2] as 'normal' | 'shiny', a.slice(3).join(' ') || 'no reason given')); break;
  case 'remove-test': console.log('removed', adminRemoveTestCards(ctx, who, a[0]!, a.slice(1).join(' ') || 'no reason given')); break;
  default: console.log('commands: failed | resolve <id> | audit [n] | trade <id> | history <copyId> | grant-test <user> <card> <variant> <reason> | remove-test <user> <reason>');
}
db.close();

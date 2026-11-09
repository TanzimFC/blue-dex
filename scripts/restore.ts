import 'dotenv/config';
import { loadPaths } from '../src/env.js';
import { restoreDatabase } from '../src/ops/backup.js';

const file = process.argv[2];
if (!file) { console.error('usage: npm run db:restore -- <backup-file>   (STOP THE BOT FIRST)'); process.exit(2); }
const p = loadPaths();
console.log(JSON.stringify(restoreDatabase(file, p.dbPath), null, 2));

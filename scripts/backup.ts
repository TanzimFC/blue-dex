import 'dotenv/config';
import { loadPaths } from '../src/env.js';
import { backupDatabase } from '../src/ops/backup.js';

const p = loadPaths();
const info = await backupDatabase(p.dbPath, p.backupDir, p.keep);
console.log(JSON.stringify({ ok: true, ...info }));

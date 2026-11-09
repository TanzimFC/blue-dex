import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from '../src/context.js';
import { openDb, type Db } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { defaultGameplay, type GameplayConfig } from '../src/gameplay.js';
import { loadCatalogueFiles, syncCatalogue } from '../src/catalogue/sync.js';
import { seededRng } from '../src/util/rng.js';

export interface TestEnv extends Ctx { now: number; advance(ms: number): void; path: string }

export function makeEnv(over: Partial<GameplayConfig> = {}, file = false): TestEnv {
  const path = file ? join(mkdtempSync(join(tmpdir(), 'bd-')), 'test.db') : ':memory:';
  const db = openDb(path);
  migrate(db);
  syncCatalogue(db, loadCatalogueFiles('catalogue'));
  const env: TestEnv = {
    db, rng: seededRng(42), path, now: Date.UTC(2026, 9, 30, 12, 0, 0),
    gameplay: { ...structuredClone(defaultGameplay), ...over },
    clock: () => env.now,
    advance(ms) { env.now += ms; },
  };
  return env;
}
/** A second connection/context onto the same file DB, sharing the clock. */
export function secondConnection(env: TestEnv): Ctx {
  const db: Db = openDb(env.path);
  return { ...env, db, rng: seededRng(7), clock: () => env.now };
}

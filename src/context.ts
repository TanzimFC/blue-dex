import type { Db } from './db/database.js';
import type { GameplayConfig } from './gameplay.js';
import type { Rng } from './util/rng.js';
import type { Clock } from './types.js';

/** Everything domain services need. Injected so tests control time, randomness and config. */
export interface Ctx {
  db: Db;
  clock: Clock;
  rng: Rng;
  gameplay: GameplayConfig;
}

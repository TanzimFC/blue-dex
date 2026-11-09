import type { Rng } from '../util/rng.js';
import type { Rarity } from '../types.js';

export function weightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('no positive weights');
  let r = rng.float() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]!; if (r < 0) return i; }
  return weights.length - 1;
}

/** Pick a rarity tier present in `defs` by weight, then uniformly within that tier. */
export function pickByRarity<T extends { rarity: Rarity }>(defs: T[], weights: Record<Rarity, number>, rng: Rng): T {
  if (!defs.length) throw new Error('empty pool');
  const tiers = [...new Set(defs.map((d) => d.rarity))].filter((t) => weights[t] > 0);
  if (!tiers.length) return defs[rng.int(defs.length)]!;
  const tier = tiers[weightedIndex(tiers.map((t) => weights[t]), rng)]!;
  const pool = defs.filter((d) => d.rarity === tier);
  return pool[rng.int(pool.length)]!;
}

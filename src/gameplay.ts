import type { Rarity } from './types.js';

/** FIXED RULE (spec §2). Not configurable by env or by anyone. */
export const CATCH_WINDOW_MS = 180_000 as const;

/** Trusted, operator-only gameplay configuration. Never exposed via /settings, /setup or any public command. */
export interface GameplayConfig {
  shinySpawnOdds: number;
  catchRarityWeights: Record<Rarity, number>;
  packShinyOdds: number; // separate mechanic from spawn shiny odds
  packRarityWeights: Record<Rarity, number>;
  dailyPackSize: number;
  weeklyPackSize: number;
  spawn: {
    minIntervalMs: number; // hard floor between non-test spawns in one guild
    maxIntervalMs: number;
    minActivityMessages: number; // messages in channel since last spawn before the next may appear
    maxPerGuildPerHour: number; // hard cap enforced in the DB-backed spawn service
    tickMs: number;
  };
  guess: {
    minGapMs: number;
    windowMs: number;
    maxWrongPerWindow: number;
    lockoutMs: number;
    guildMaxPerWindow: number;
    guildWindowMs: number;
  };
  trade: { expiryMs: number; maxItemsPerSide: number };
}

export const defaultGameplay: GameplayConfig = {
  shinySpawnOdds: 0.02,
  catchRarityWeights: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 },
  packShinyOdds: 0.01,
  packRarityWeights: { common: 55, uncommon: 28, rare: 12, epic: 4, legendary: 1 },
  dailyPackSize: 1,
  weeklyPackSize: 3,
  spawn: { minIntervalMs: 15 * 60_000, maxIntervalMs: 40 * 60_000, minActivityMessages: 5, maxPerGuildPerHour: 3, tickMs: 30_000 },
  guess: { minGapMs: 1_500, windowMs: 60_000, maxWrongPerWindow: 8, lockoutMs: 60_000, guildMaxPerWindow: 40, guildWindowMs: 10_000 },
  trade: { expiryMs: 15 * 60_000, maxItemsPerSide: 5 },
};

function num(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number in [${min}, ${max}]`);
  return n;
}

export function gameplayFromEnv(env: NodeJS.ProcessEnv): GameplayConfig {
  const g: GameplayConfig = structuredClone(defaultGameplay);
  g.shinySpawnOdds = num(env, 'SHINY_SPAWN_ODDS', 0, 1) ?? g.shinySpawnOdds;
  g.packShinyOdds = num(env, 'PACK_SHINY_ODDS', 0, 1) ?? g.packShinyOdds;
  const mn = num(env, 'SPAWN_MIN_INTERVAL_MIN', 1, 1440);
  const mx = num(env, 'SPAWN_MAX_INTERVAL_MIN', 1, 2880);
  if (mn !== undefined) g.spawn.minIntervalMs = mn * 60_000;
  if (mx !== undefined) g.spawn.maxIntervalMs = mx * 60_000;
  if (g.spawn.maxIntervalMs < g.spawn.minIntervalMs) throw new Error('SPAWN_MAX_INTERVAL_MIN must be >= SPAWN_MIN_INTERVAL_MIN');
  g.spawn.maxPerGuildPerHour = num(env, 'SPAWN_MAX_PER_GUILD_PER_HOUR', 1, 20) ?? g.spawn.maxPerGuildPerHour;
  return g;
}

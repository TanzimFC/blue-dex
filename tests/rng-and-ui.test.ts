import { describe, it, expect } from 'vitest';
import { systemRng } from '../src/util/rng.js';
import { makeEnv } from './helpers.js';
import { createSpawn } from '../src/domain/spawn.js';
import { claimPeriodic } from '../src/domain/rewards.js';
import { resolveArt, artParts } from '../src/discord/art.js';
import { cardEmbed } from '../src/discord/embeds.js';
import { commandJson } from '../src/discord/commands/definitions.js';
import { loadEnv } from '../src/env.js';
import { gameplayFromEnv, CATCH_WINDOW_MS } from '../src/gameplay.js';

describe('production RNG (regression: float() used to throw)', () => {
  it('float is within [0,1) and roughly uniform', () => {
    let below = 0; const n = 20000;
    for (let i = 0; i < n; i++) { const f = systemRng.float(); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(1); if (f < 0.5) below++; }
    expect(below / n).toBeGreaterThan(0.47); expect(below / n).toBeLessThan(0.53);
  });
  it('shortId has the right alphabet/length; uuid is unique', () => {
    expect(systemRng.shortId(8)).toMatch(/^[A-HJKMNP-TV-Z2-9]{8}$/);
    expect(new Set(Array.from({ length: 1000 }, () => systemRng.uuid())).size).toBe(1000);
  });
  it('spawns and packs work end-to-end with the real RNG', () => {
    const env = { ...makeEnv(), rng: systemRng };
    expect(createSpawn(env, { guildId: 'g', channelId: 'c' }).ok).toBe(true);
    expect(claimPeriodic(env, '1', 'a', 'weekly').ok).toBe(true);
  });
  it('shiny frequency over many real-RNG spawns tracks the configured odds', () => {
    const env = { ...makeEnv({ shinySpawnOdds: 0.25, spawn: { minIntervalMs: 0, maxIntervalMs: 1, minActivityMessages: 0, maxPerGuildPerHour: 1e9, tickMs: 1 } }), rng: systemRng };
    let shiny = 0; const n = 2000;
    for (let i = 0; i < n; i++) { const r = createSpawn(env, { guildId: 'g' + i, channelId: 'c' }); if (r.ok && r.spawn.variant === 'shiny') shiny++; }
    expect(shiny / n).toBeGreaterThan(0.21); expect(shiny / n).toBeLessThan(0.29);
  });
});

describe('artwork fallbacks', () => {
  it('missing/invalid art resolves to "missing" without throwing', () => {
    expect(resolveArt('file:nope/missing.png', 'assets').kind).toBe('missing');
    expect(resolveArt('file:../../etc/passwd', 'assets').kind).toBe('missing');
    expect(resolveArt('', 'assets').kind).toBe('missing');
    expect(artParts({ kind: 'missing' }, 'x.png')).toEqual({});
  });
  it('card embed renders (with a footer note) when art is missing', () => {
    const { embed, files } = cardEmbed({ card_id: 'x', edition_name: 'E', rarity: 'rare', set_name: 'S', character_name: 'C', normal_card_art: 'file:none.png', shiny_card_art: 'file:none2.png' }, 'shiny', 'assets');
    expect(files).toHaveLength(0);
    expect(embed.toJSON().footer?.text).toMatch(/unavailable/i);
  });
});

describe('server-admin surface & configuration', () => {
  it('no slash command exposes odds / rates / intervals / reward amounts', () => {
    const names: string[] = [];
    const walk = (o: any) => { names.push(o.name); (o.options ?? []).forEach(walk); };
    commandJson().forEach(walk);
    expect(names.filter((n) => /odds|rate|interval|weight|amount|pack_size|shiny_chance/i.test(n))).toEqual([]);
    const settings = commandJson().find((c) => c.name === 'settings') as any;
    expect(settings.options.map((o: any) => o.name).sort()).toEqual(['compact', 'spawns', 'view']);
  });
  it('catch window is a fixed constant and not env-configurable', () => {
    expect(CATCH_WINDOW_MS).toBe(180_000);
    const g = gameplayFromEnv({ CATCH_WINDOW_MS: '5' } as any);
    expect(JSON.stringify(g)).not.toContain('180000'); // not a config field at all
  });
  it('operator env validates ranges', () => {
    expect(() => gameplayFromEnv({ SHINY_SPAWN_ODDS: '2' } as any)).toThrow();
    expect(gameplayFromEnv({ SHINY_SPAWN_ODDS: '0.5' } as any).shinySpawnOdds).toBe(0.5);
  });
  it('loadEnv rejects missing secrets and never echoes values', () => {
    expect(() => loadEnv({} as any)).toThrow(/DISCORD_TOKEN/);
    try { loadEnv({ DISCORD_TOKEN: 'short-secret-value' } as any); } catch (e) { expect(String(e)).not.toContain('short-secret-value'); }
  });
});

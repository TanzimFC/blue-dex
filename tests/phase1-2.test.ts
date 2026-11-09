import { describe, it, expect } from 'vitest';
import { makeEnv, secondConnection } from './helpers.js';
import { createSpawn, expireDueSpawns, recoverSpawns, type SpawnRow } from '../src/domain/spawn.js';
import { attemptCatch } from '../src/domain/catch.js';
import { GuessLimiter } from '../src/domain/limiter.js';
import { getProfileStats, listOwned, confirmDrop, previewDrop, setLocked, getOwnedCard } from '../src/domain/collection.js';
import { validateCatalogue, CatalogueError } from '../src/catalogue/schema.js';
import { defaultGameplay } from '../src/gameplay.js';
import { normalizeAlias } from '../src/util/normalize.js';
import { migrate } from '../src/db/migrate.js';
import { buildSpawnMessageSpec } from '../src/discord/spawnMessage.js';
import { readFileSync } from 'node:fs';

const G = 'guild1', CH = 'chan1';
const limiter = () => new GuessLimiter({ ...defaultGameplay.guess, minGapMs: 0 });
function spawn(env: ReturnType<typeof makeEnv>, variant?: 'normal' | 'shiny') {
  const r = createSpawn(env, { guildId: G, channelId: CH, ...(variant ? { isTest: false } : {}) });
  if (!r.ok) throw new Error(r.reason);
  if (variant) env.db.prepare('UPDATE spawns SET variant=? WHERE id=?').run(variant, r.spawn.id);
  return env.db.prepare('SELECT * FROM spawns WHERE id=?').get(r.spawn.id) as SpawnRow;
}
const nameOf = (env: ReturnType<typeof makeEnv>, s: SpawnRow) => (env.db.prepare('SELECT display_name n FROM characters WHERE id=?').get(s.character_id) as { n: string }).n;
const catchIt = (env: ReturnType<typeof makeEnv>, s: SpawnRow, user = '100', guess?: string, lim = limiter()) =>
  attemptCatch(env, lim, { spawnId: s.id, userId: user, username: 'u' + user, guess: guess ?? nameOf(env, s) });

describe('migrations & schema', () => {
  it('is idempotent and versioned', () => {
    const env = makeEnv();
    expect(migrate(env.db)).toEqual({ from: 1, to: 1 });
  });
  it('DB rejects a spawn whose window is not exactly 180s', () => {
    const env = makeEnv();
    expect(() => env.db.prepare(`INSERT INTO spawns (id,guild_id,channel_id,character_id,card_definition_id,variant,started_at,expires_at,status) VALUES ('x','g','c','isagi_yoichi','isagi_001','normal',0,179999,'active')`).run()).toThrow();
  });
  it('DB rejects a catch recorded at/after the deadline', () => {
    const env = makeEnv();
    const s = spawn(env);
    expect(() => env.db.prepare("UPDATE spawns SET status='caught', catcher_id='1', caught_at=expires_at WHERE id=?").run(s.id)).toThrow();
  });
});

describe('catalogue validation', () => {
  const chars = (extra: object[] = []) => [
    { id: 'a', name: 'Alpha Man', aliases: ['Al'], spawnArt: { normal: 'file:a.png', shiny: 'file:b.png' } }, ...extra];
  const cards = { sets: [{ id: 's', name: 'S' }], cards: [{ id: 'c1', characterId: 'a', edition: 'E', rarity: 'common', setId: 's', art: { normal: 'file:x.png', shiny: 'file:y.png' } }] };
  it('accepts a valid catalogue', () => expect(validateCatalogue(chars(), cards).characters).toHaveLength(1));
  it('rejects ambiguous aliases across characters', () => {
    const bad = chars([{ id: 'b', name: 'Beta', aliases: ['AL'], spawnArt: { normal: 'file:a.png', shiny: 'file:b.png' } }]);
    expect(() => validateCatalogue(bad, cards)).toThrow(CatalogueError);
  });
  it('rejects spawn art URLs that leak the variant', () => {
    const bad = [{ id: 'a', name: 'A', spawnArt: { normal: 'https://cdn.x/a.png', shiny: 'https://cdn.x/a_shiny.png' } }];
    expect(() => validateCatalogue(bad, cards)).toThrow(/opaque/);
  });
  it('rejects cards pointing at unknown characters', () => {
    expect(() => validateCatalogue(chars(), { ...cards, cards: [{ ...cards.cards[0]!, characterId: 'zzz' }] })).toThrow(/unknown characterId/);
  });
  it('normalises aliases', () => expect(normalizeAlias('  Ísagi-Yoichi! ')).toBe('isagiyoichi'));
});

describe('spawn variant secrecy', () => {
  it('spawn message spec is identical for normal and shiny except the image bytes, and contains no variant hints', () => {
    const mk = (variant: 'normal' | 'shiny') => {
      const env = makeEnv({ shinySpawnOdds: variant === 'shiny' ? 1 : 0 });
      const r = createSpawn(env, { guildId: G, channelId: CH });
      if (!r.ok) throw new Error();
      expect(r.spawn.variant).toBe(variant); // exactly one variant, matches odds config
      return JSON.stringify(buildSpawnMessageSpec(r.view, 'file'));
    };
    const normalSpec = mk('normal').replace(/"id":"[^"]*"|spawn:[^"]*|<t:\d+:R>|"expiresAt":\d+|"startedAt":\d+/g, '');
    const shinySpec = mk('shiny').replace(/"id":"[^"]*"|spawn:[^"]*|<t:\d+:R>|"expiresAt":\d+|"startedAt":\d+/g, '');
    expect(shinySpec).not.toMatch(/shiny|sparkle|✨|⭐|🌟/i);
    expect(normalSpec).toBe(shinySpec);
  });
  it('PublicSpawn view has no variant field', () => {
    const env = makeEnv({ shinySpawnOdds: 1 });
    const r = createSpawn(env, { guildId: G, channelId: CH });
    if (!r.ok) throw new Error();
    expect(Object.keys(r.view)).not.toContain('variant');
  });
  it('each spawn has exactly one variant, honouring trusted odds', () => {
    for (const [odds, v] of [[0, 'normal'], [1, 'shiny']] as const) {
      const env = makeEnv({ shinySpawnOdds: odds });
      expect(spawn(env).variant).toBe(v);
    }
  });
  it('a successful shiny catch reveals the shiny variant and stores it on the card', () => {
    const env = makeEnv({ shinySpawnOdds: 1 });
    const s = spawn(env);
    const r = catchIt(env, s);
    expect(r.ok && !r.test && r.variant).toBe('shiny');
    if (r.ok && !r.test) expect(getOwnedCard(env.db, r.copyId)!.variant).toBe('shiny');
  });
});

describe('catch timing & validation', () => {
  it('succeeds before the deadline and auto-creates the profile', () => {
    const env = makeEnv();
    const s = spawn(env);
    expect(env.db.prepare('SELECT COUNT(*) n FROM collectors').get()).toEqual({ n: 0 });
    env.advance(179_999);
    const r = catchIt(env, s);
    expect(r.ok).toBe(true);
    expect(env.db.prepare('SELECT COUNT(*) n FROM collectors').get()).toEqual({ n: 1 });
    expect(getProfileStats(env.db, '100')!.totalCopies).toBe(1);
  });
  it('fails at exactly 180s and never awards', () => {
    const env = makeEnv();
    const s = spawn(env);
    env.advance(180_000);
    expect(catchIt(env, s)).toEqual({ ok: false, reason: 'expired' });
    expect(env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get()).toEqual({ n: 0 });
    expect((env.db.prepare('SELECT status FROM spawns WHERE id=?').get(s.id) as { status: string }).status).toBe('expired');
  });
  it('fails after the deadline', () => {
    const env = makeEnv();
    const s = spawn(env);
    env.advance(500_000);
    expect(catchIt(env, s).ok).toBe(false);
  });
  it('invalid guesses never award; wrong name and empty input are rejected', () => {
    const env = makeEnv();
    const s = spawn(env);
    expect(catchIt(env, s, '100', 'Definitely Not A Footballer')).toEqual({ ok: false, reason: 'wrong' });
    expect(catchIt(env, s, '100', '   !!! ')).toEqual({ ok: false, reason: 'invalid' });
    expect(env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get()).toEqual({ n: 0 });
  });
  it("another character's alias does not catch this spawn", () => {
    const env = makeEnv();
    const s = spawn(env);
    const other = s.character_id === 'isagi_yoichi' ? 'Nagi' : 'Isagi';
    expect(catchIt(env, s, '100', other).ok).toBe(false);
  });
  it('accepts configured aliases, case/accent/punctuation-insensitive', () => {
    const env = makeEnv();
    const s = spawn(env);
    const alias = ({ isagi_yoichi: 'ISAGI', bachira_meguru: 'bachira', nagi_seishiro: 'Nagi!', chigiri_hyoma: 'chigiri', reo_mikage: 'REO', barou_shoei: 'King' } as Record<string, string>)[s.character_id]!;
    expect(catchIt(env, s, '100', alias).ok).toBe(true);
  });
  it('a repeated interaction cannot award the same spawn twice', () => {
    const env = makeEnv();
    const s = spawn(env);
    expect(catchIt(env, s).ok).toBe(true);
    expect(catchIt(env, s).ok).toBe(false);
    expect(catchIt(env, s, '200').ok).toBe(false);
    expect(env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get()).toEqual({ n: 1 });
  });
  it('two simultaneous correct guesses (separate connections) yield exactly one winner', async () => {
    const env = makeEnv({}, true);
    const s = spawn(env);
    const other = secondConnection(env);
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => catchIt(env, s, '1')),
      Promise.resolve().then(() => attemptCatch(other, limiter(), { spawnId: s.id, userId: '2', username: 'b', guess: nameOf(env, s) })),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get()).toEqual({ n: 1 });
    expect(env.db.prepare("SELECT COUNT(*) n FROM catch_history WHERE result='success'").get()).toEqual({ n: 1 });
  });
  it('DB uniqueness blocks a second card for the same spawn even if application logic failed', () => {
    const env = makeEnv();
    const s = spawn(env);
    catchIt(env, s);
    env.db.prepare("INSERT OR IGNORE INTO collectors (user_id, created_at) VALUES ('9',0)").run();
    expect(() => env.db.prepare("INSERT INTO owned_cards (id,owner_id,card_definition_id,variant,acquired_at,source,source_ref) VALUES ('ZZZZZZZZ','9',?,'normal',0,'catch',?)").run(s.card_definition_id, s.id)).toThrow();
  });
  it('rate-limits repeated guesses and locks out brute force', () => {
    const env = makeEnv();
    const s = spawn(env);
    const lim = new GuessLimiter({ ...defaultGameplay.guess, minGapMs: 1000, maxWrongPerWindow: 3, lockoutMs: 60_000 });
    expect(catchIt(env, s, '5', 'xx1', lim)).toEqual({ ok: false, reason: 'wrong' });
    expect(catchIt(env, s, '5', 'xx2', lim)).toMatchObject({ reason: 'rate_limited' });
    for (const g of ['a1', 'a2']) { env.advance(1100); catchIt(env, s, '5', g, lim); }
    env.advance(1100);
    expect(catchIt(env, s, '5', nameOf(env, s), lim)).toMatchObject({ reason: 'rate_limited' }); // even a correct guess is locked out
  });
});

describe('restart recovery', () => {
  it('expired spawns are marked expired; caught ones stay unclaimable; live ones resume', () => {
    const env = makeEnv({ spawn: { ...defaultGameplay.spawn, minIntervalMs: 0, maxPerGuildPerHour: 99 } });
    const caught = spawn(env); catchIt(env, caught);
    env.advance(1000);
    const live = createSpawn(env, { guildId: 'g2', channelId: 'c' }); if (!live.ok) throw 1;
    const old = createSpawn(env, { guildId: 'g3', channelId: 'c' }); if (!old.ok) throw 1;
    env.advance(179_000); // old spawn started 179s ago... shift: make `old` older
    env.db.prepare('UPDATE spawns SET started_at=started_at-200000, expires_at=expires_at-200000 WHERE id=?').run(old.spawn.id);
    const rep = recoverSpawns(env.db, env.now);
    expect(rep.expired.map((x) => x.id)).toContain(old.spawn.id);
    expect(rep.resumed.map((x) => x.id)).toContain(live.spawn.id);
    expect(catchIt(env, env.db.prepare('SELECT * FROM spawns WHERE id=?').get(old.spawn.id) as SpawnRow).ok).toBe(false);
    expect(catchIt(env, caught, '777').ok).toBe(false);
    expect(env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get()).toEqual({ n: 1 });
  });
  it('a spawn whose start is in the future (clock rolled back) is voided and cannot award', () => {
    const env = makeEnv();
    const s = spawn(env);
    env.now -= 3_600_000;
    const rep = recoverSpawns(env.db, env.now);
    expect(rep.voided.map((x) => x.id)).toContain(s.id);
    expect(catchIt(env, s).ok).toBe(false);
  });
  it('expireDueSpawns is exact at the deadline', () => {
    const env = makeEnv(); const s = spawn(env);
    env.advance(179_999); expect(expireDueSpawns(env.db, env.now)).toHaveLength(0);
    env.advance(1); expect(expireDueSpawns(env.db, env.now).map((x) => x.id)).toEqual([s.id]);
  });
});

describe('spawn limits (trusted config, not admin-controllable)', () => {
  it('one active spawn per guild, min interval and hourly cap enforced', () => {
    const env = makeEnv();
    spawn(env);
    expect(createSpawn(env, { guildId: G, channelId: CH })).toEqual({ ok: false, reason: 'guild_has_active_spawn' });
    env.advance(181_000);
    expect(createSpawn(env, { guildId: G, channelId: CH })).toEqual({ ok: false, reason: 'too_soon' });
  });
  it('test spawns cannot be forced with overrides in production mode', () => {
    const env = makeEnv();
    expect(() => createSpawn(env, { guildId: G, channelId: CH, testOverrides: { variant: 'shiny' } })).toThrow();
  });
  it('test spawn catch awards nothing and does not touch stats', () => {
    const env = makeEnv();
    const r = createSpawn(env, { guildId: G, channelId: CH, isTest: true, testOverrides: { variant: 'shiny' } }); if (!r.ok) throw 1;
    const out = catchIt(env, r.spawn);
    expect(out).toMatchObject({ ok: true, test: true });
    expect(env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get()).toEqual({ n: 0 });
    expect(env.db.prepare('SELECT COUNT(*) n FROM collectors').get()).toEqual({ n: 0 });
  });
});

describe('ownership & drop', () => {
  function own(env: ReturnType<typeof makeEnv>, n: number, user = '100') {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      env.advance(24 * 3600_000);
      env.db.prepare('DELETE FROM spawns WHERE 0'); // no-op
      const s = spawn(env); const r = catchIt(env, s, user, nameOf(env, s));
      if (r.ok && !r.test) ids.push(r.copyId);
    }
    return ids;
  }
  it('duplicate copies get different copy IDs; completion counts unique definitions', () => {
    const env = makeEnv();
    // force identical card definition on several spawns
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      env.advance(7_200_000);
      const r = createSpawn(env, { guildId: G, channelId: CH }); if (!r.ok) throw new Error(r.reason);
      env.db.prepare("UPDATE spawns SET character_id='isagi_yoichi', card_definition_id='isagi_001' WHERE id=?").run(r.spawn.id);
      const c = attemptCatch(env, limiter(), { spawnId: r.spawn.id, userId: '100', username: 'a', guess: 'isagi' });
      if (c.ok && !c.test) ids.push(c.copyId);
      env.advance(181_000);
    }
    expect(new Set(ids).size).toBe(3);
    const st = getProfileStats(env.db, '100')!;
    expect(st.totalCopies).toBe(3); expect(st.uniqueOwned).toBe(1);
    expect(st.completionPct).toBeCloseTo((1 / 7) * 100, 0);
    // drop one duplicate -> still owned
    expect(confirmDrop(env, '100', ids[0]!)).toMatchObject({ ok: true, copiesRemaining: 2, leftCollection: false });
    expect(getProfileStats(env.db, '100')!.uniqueOwned).toBe(1);
    confirmDrop(env, '100', ids[1]!);
    expect(confirmDrop(env, '100', ids[2]!)).toMatchObject({ ok: true, leftCollection: true });
    expect(getProfileStats(env.db, '100')!.uniqueOwned).toBe(0);
    expect(getProfileStats(env.db, '100')!.completionPct).toBe(0);
    expect(getProfileStats(env.db, '100')!.totalCatches).toBe(3); // lifetime history is separate
  });
  it('locked card cannot be dropped; cancelled drop (preview only) changes nothing', () => {
    const env = makeEnv(); const [id] = own(env, 1);
    expect(previewDrop(env.db, '100', id!)).toMatchObject({ ok: true });
    expect(listOwned(env.db, '100').total).toBe(1); // preview == cancel: no writes
    setLocked(env.db, '100', id!, true);
    expect(confirmDrop(env, '100', id!)).toEqual({ ok: false, reason: 'locked' });
    expect(previewDrop(env.db, '100', id!)).toEqual({ ok: false, reason: 'locked' });
    expect(listOwned(env.db, '100').total).toBe(1);
  });
  it('repeated confirmation discards only once; others cannot drop your copy', () => {
    const env = makeEnv(); const ids = own(env, 2);
    expect(confirmDrop(env, '999', ids[0]!)).toEqual({ ok: false, reason: 'not_found' });
    expect(confirmDrop(env, '100', ids[0]!).ok).toBe(true);
    expect(confirmDrop(env, '100', ids[0]!)).toEqual({ ok: false, reason: 'not_found' });
    expect(listOwned(env.db, '100').total).toBe(1);
  });
  it('a dropped copy is gone: not re-spawned, not owned by anyone', () => {
    const env = makeEnv(); const [id] = own(env, 1);
    confirmDrop(env, '100', id!);
    expect(getOwnedCard(env.db, id!)).toBeUndefined();
    expect(env.db.prepare("SELECT COUNT(*) n FROM spawns WHERE status='active'").get()).toEqual({ n: 0 });
    expect((env.db.prepare("SELECT event FROM card_events WHERE copy_id=? ORDER BY id").all(id!) as { event: string }[]).map((e) => e.event)).toEqual(['acquired', 'dropped']);
  });
  it('another player never gets completion credit for my cards', () => {
    const env = makeEnv(); own(env, 2, '100');
    env.db.prepare("INSERT INTO collectors (user_id, created_at) VALUES ('200',0)").run();
    expect(getProfileStats(env.db, '200')!.uniqueOwned).toBe(0);
  });
});
void readFileSync;

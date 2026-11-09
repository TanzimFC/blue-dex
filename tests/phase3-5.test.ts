import { describe, it, expect } from 'vitest';
import { makeEnv, secondConnection, type TestEnv } from './helpers.js';
import { claimPeriodic, seedQuests, evaluateMilestones } from '../src/domain/rewards.js';
import { ensureCollector, grantCopy, getProfileStats, confirmDrop, setLocked, getOwnedCard, dexPage, listOwned } from '../src/domain/collection.js';
import { leaderboard } from '../src/domain/leaderboard.js';
import { proposeTrade, acceptTrade, confirmTrade, cancelTrade, declineTrade, expireTrades, getTradeView } from '../src/domain/trade.js';
import { updateGuildSetting, authorizeTestSpawn, adminGrantTestCard, adminRemoveTestCards, getGuildSettings } from '../src/domain/admin.js';
import { migrate } from '../src/db/migrate.js';
import { createSpawn } from '../src/domain/spawn.js';
import { attemptCatch } from '../src/domain/catch.js';
import { GuessLimiter } from '../src/domain/limiter.js';
import { defaultGameplay } from '../src/gameplay.js';

const give = (env: TestEnv, user: string, card = 'isagi_001', variant: 'normal' | 'shiny' = 'normal') => {
  ensureCollector(env.db, user, 'u' + user, env.now);
  return grantCopy(env, { ownerId: user, cardDefinitionId: card, variant, source: 'admin_test', sourceRef: null });
};
const owner = (env: TestEnv, id: string) => (env.db.prepare('SELECT owner_id o FROM owned_cards WHERE id=?').get(id) as { o: string } | undefined)?.o;
const count = (env: TestEnv) => (env.db.prepare('SELECT COUNT(*) n FROM owned_cards').get() as { n: number }).n;

describe('daily / weekly rewards', () => {
  it('daily cannot be claimed twice in the same UTC day, resets at 00:00 UTC, and is recorded', () => {
    const env = makeEnv();
    env.now = Date.UTC(2026, 9, 30, 23, 59, 0);
    const a = claimPeriodic(env, '1', 'a', 'daily');
    expect(a.ok && a.cards).toHaveLength(1);
    const b = claimPeriodic(env, '1', 'a', 'daily');
    expect(b).toEqual({ ok: false, reason: 'already_claimed', nextClaimAt: Date.UTC(2026, 9, 31) });
    expect(count(env)).toBe(1);
    env.advance(61_000); // 00:00:01 next day
    expect(claimPeriodic(env, '1', 'a', 'daily').ok).toBe(true);
    expect(env.db.prepare("SELECT COUNT(*) n FROM reward_claims WHERE reward_type='daily'").get()).toEqual({ n: 2 });
  });
  it('weekly resets Monday 00:00 UTC', () => {
    const env = makeEnv();
    env.now = Date.UTC(2026, 9, 30, 12); // Friday
    const a = claimPeriodic(env, '1', 'a', 'weekly');
    expect(a.ok && a.cards).toHaveLength(3);
    expect(a.ok && a.nextClaimAt).toBe(Date.UTC(2026, 10, 2)); // Mon 2 Nov
    expect(claimPeriodic(env, '1', 'a', 'weekly').ok).toBe(false);
    env.now = Date.UTC(2026, 10, 1, 23, 59); // Sunday
    expect(claimPeriodic(env, '1', 'a', 'weekly').ok).toBe(false);
    env.now = Date.UTC(2026, 10, 2, 0, 0, 1);
    expect(claimPeriodic(env, '1', 'a', 'weekly').ok).toBe(true);
  });
  it('repeated/concurrent claims (two connections) grant exactly once', () => {
    const env = makeEnv({}, true); const other = secondConnection(env);
    const rs = [claimPeriodic(env, '1', 'a', 'daily'), claimPeriodic(other, '1', 'a', 'daily'), claimPeriodic(env, '1', 'a', 'daily')];
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(env.db.prepare("SELECT COUNT(*) n FROM owned_cards WHERE source='daily'").get()).toEqual({ n: 1 });
  });
  it('DB itself rejects a duplicate claim row', () => {
    const env = makeEnv(); claimPeriodic(env, '1', 'a', 'daily');
    expect(() => env.db.prepare("INSERT INTO reward_claims (id,user_id,reward_type,period_key,claimed_at) VALUES ('dup','1','daily',?,0)").run('2026-10-30')).toThrow();
  });
  it('pack shiny odds are independent from spawn shiny odds', () => {
    const env = makeEnv({ shinySpawnOdds: 1, packShinyOdds: 0 });
    const r = claimPeriodic(env, '1', 'a', 'weekly');
    expect(r.ok && r.cards.every((c) => c.variant === 'normal')).toBe(true);
    const env2 = makeEnv({ shinySpawnOdds: 0, packShinyOdds: 1 });
    const r2 = claimPeriodic(env2, '1', 'a', 'weekly');
    expect(r2.ok && r2.cards.every((c) => c.variant === 'shiny')).toBe(true);
  });
});

describe('milestones', () => {
  it('first catch milestone is granted once; drop-and-regain cannot farm it', () => {
    const env = makeEnv({ spawn: { ...defaultGameplay.spawn, minIntervalMs: 0, maxPerGuildPerHour: 99 } }); seedQuests(env);
    const s = createSpawn(env, { guildId: 'g', channelId: 'c' }); if (!s.ok) throw 1;
    const name = (env.db.prepare('SELECT display_name n FROM characters WHERE id=?').get(s.spawn.character_id) as { n: string }).n;
    const c = attemptCatch(env, new GuessLimiter({ ...defaultGameplay.guess, minGapMs: 0 }), { spawnId: s.spawn.id, userId: '1', username: 'a', guess: name });
    expect(c.ok).toBe(true);
    const g = evaluateMilestones(env, '1');
    expect(g.map((x) => x.questId)).toContain('first_catch');
    expect(evaluateMilestones(env, '1')).toEqual([]);
    expect(env.db.prepare("SELECT COUNT(*) n FROM reward_claims WHERE reward_type='milestone' AND period_key='first_catch'").get()).toEqual({ n: 1 });
  });
  it('set completion counts only currently-owned cards in that set', () => {
    const env = makeEnv(); seedQuests(env);
    const genesis = (env.db.prepare("SELECT id FROM card_definitions WHERE set_id='genesis'").all() as { id: string }[]).map((r) => r.id);
    ensureCollector(env.db, '1', 'a', env.now);
    for (const id of genesis.slice(0, -1)) give(env, '1', id);
    expect(evaluateMilestones(env, '1').map((x) => x.questId)).not.toContain('set_genesis');
    give(env, '1', genesis.at(-1)!);
    expect(evaluateMilestones(env, '1').map((x) => x.questId)).toContain('set_genesis');
  });
});

describe('leaderboard', () => {
  it('ranks by unique cards, not duplicate count; excludes private profiles', () => {
    const env = makeEnv();
    for (let i = 0; i < 6; i++) give(env, 'dup'); // 6 copies, 1 unique
    give(env, 'div', 'isagi_001'); give(env, 'div', 'nagi_001');
    give(env, 'hidden', 'isagi_001'); give(env, 'hidden', 'nagi_001'); give(env, 'hidden', 'reo_001');
    env.db.prepare("UPDATE collectors SET profile_public=0 WHERE user_id='hidden'").run();
    const b = leaderboard(env.db, 'unique');
    expect(b.map((r) => r.userId)).toEqual(['div', 'dup']);
    expect(b[1]!.value).toBe(1);
    expect(leaderboard(env.db, 'score')[0]!.userId).toBe('div');
    const sh = leaderboard(env.db, 'shiny'); expect(sh.every((r) => r.value === 0)).toBe(true);
  });
});

describe('dex / list filters', () => {
  it('distinguishes owned vs catalogue and paginates', () => {
    const env = makeEnv(); give(env, '1', 'isagi_001', 'shiny'); give(env, '1', 'isagi_001');
    const all = dexPage(env.db, '1', { pageSize: 3 });
    expect(all.total).toBe(7); expect(all.pages).toBe(3);
    const row = dexPage(env.db, '1', {}).rows.find((r) => r.card_id === 'isagi_001')!;
    expect([row.owned_normal, row.owned_shiny]).toEqual([1, 1]);
    expect(dexPage(env.db, '1', { show: 'owned' }).total).toBe(1);
    expect(dexPage(env.db, '1', { show: 'missing' }).total).toBe(6);
    expect(listOwned(env.db, '1', { variant: 'shiny' }).total).toBe(1);
    expect(listOwned(env.db, '1', { search: 'Awakened' }).total).toBe(2);
  });
});

describe('trading', () => {
  const setup = () => {
    const env = makeEnv();
    const a1 = give(env, 'A', 'isagi_001'), a2 = give(env, 'A', 'nagi_001'), b1 = give(env, 'B', 'reo_001'), b2 = give(env, 'B', 'barou_001');
    return { env, a1, a2, b1, b2 };
  };
  it('happy path swaps both sides atomically and records history', () => {
    const { env, a1, b1 } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [b1] }); if (!p.ok) throw new Error(p.reason);
    expect(env.db.prepare('SELECT state FROM owned_cards WHERE id=?').get(a1)).toEqual({ state: 'reserved' });
    expect(acceptTrade(env, p.tradeId, 'B').ok).toBe(true);
    expect(confirmTrade(env, p.tradeId, 'A').ok).toBe(true);
    expect([owner(env, a1), owner(env, b1)]).toEqual(['B', 'A']);
    expect(getOwnedCard(env.db, a1)!.state).toBe('owned');
    expect(getTradeView(env.db, p.tradeId)!.trade.status).toBe('completed');
    expect(env.db.prepare("SELECT COUNT(*) n FROM card_events WHERE event='transferred'").get()).toEqual({ n: 2 });
    expect(getProfileStats(env.db, 'A')!.uniqueOwned).toBe(2);
  });
  it('replayed confirm/accept cannot double-transfer', () => {
    const { env, a1, b1 } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [b1] }); if (!p.ok) throw 1;
    acceptTrade(env, p.tradeId, 'B'); confirmTrade(env, p.tradeId, 'A');
    expect(confirmTrade(env, p.tradeId, 'A')).toMatchObject({ ok: false, reason: 'bad_state' });
    expect(acceptTrade(env, p.tradeId, 'B')).toMatchObject({ ok: false });
    expect([owner(env, a1), owner(env, b1)]).toEqual(['B', 'A']);
  });
  it('only the owner can offer; cannot request cards the recipient lacks; no self trade', () => {
    const { env, a1, b1 } = setup();
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [b1], requestCopyIds: [] })).toMatchObject({ reason: 'not_owner' });
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [a1] })).toMatchObject({ reason: 'duplicate_items' });
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: ['NOPE1234'] })).toMatchObject({ reason: 'not_owner' });
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'A', offerCopyIds: [a1], requestCopyIds: [] })).toMatchObject({ reason: 'self_trade' });
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'ghost', offerCopyIds: [a1], requestCopyIds: [] })).toMatchObject({ reason: 'recipient_unknown' });
  });
  it('locked or already-reserved copies cannot be traded; one copy cannot be in two trades', () => {
    const { env, a1, a2, b1 } = setup();
    setLocked(env.db, 'A', a2, true);
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a2], requestCopyIds: [] })).toMatchObject({ reason: 'ineligible' });
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] }); expect(p.ok).toBe(true);
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] })).toMatchObject({ reason: 'ineligible' });
    expect(confirmDrop(env, 'A', a1)).toEqual({ ok: false, reason: 'reserved' }); // reserved copies can't be discarded
    void b1;
  });
  it('cancel / decline / expiry release reservations', () => {
    const { env, a1, a2, b1 } = setup();
    const p1 = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [b1] }); if (!p1.ok) throw 1;
    acceptTrade(env, p1.tradeId, 'B');
    expect(env.db.prepare("SELECT COUNT(*) n FROM owned_cards WHERE state='reserved'").get()).toEqual({ n: 2 });
    expect(cancelTrade(env, p1.tradeId, 'A').ok).toBe(true);
    expect(env.db.prepare("SELECT COUNT(*) n FROM owned_cards WHERE state='reserved'").get()).toEqual({ n: 0 });
    const p2 = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a2], requestCopyIds: [] }); if (!p2.ok) throw 1;
    expect(declineTrade(env, p2.tradeId, 'A')).toMatchObject({ reason: 'forbidden' });
    expect(declineTrade(env, p2.tradeId, 'B').ok).toBe(true);
    const p3 = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] }); if (!p3.ok) throw 1;
    env.advance(env.gameplay.trade.expiryMs);
    expect(expireTrades(env)).toBe(1);
    expect(env.db.prepare("SELECT COUNT(*) n FROM owned_cards WHERE state='reserved'").get()).toEqual({ n: 0 });
    expect(acceptTrade(env, p3.tradeId, 'B')).toMatchObject({ ok: false });
    expect([owner(env, a1), owner(env, a2)]).toEqual(['A', 'A']);
  });
  it('accept after expiry fails lazily and releases', () => {
    const { env, a1 } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] }); if (!p.ok) throw 1;
    env.advance(env.gameplay.trade.expiryMs + 1);
    expect(acceptTrade(env, p.tradeId, 'B')).toMatchObject({ reason: 'expired' });
    expect(getOwnedCard(env.db, a1)!.state).toBe('owned');
  });
  it('final revalidation: locking a reserved card before confirm fails the whole trade with no partial transfer', () => {
    const { env, a1, b1 } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [b1] }); if (!p.ok) throw 1;
    acceptTrade(env, p.tradeId, 'B');
    setLocked(env.db, 'B', b1, true);
    expect(confirmTrade(env, p.tradeId, 'A')).toMatchObject({ ok: false, reason: 'revalidation_failed' });
    expect([owner(env, a1), owner(env, b1)]).toEqual(['A', 'B']);
    expect(env.db.prepare("SELECT COUNT(*) n FROM owned_cards WHERE state='reserved'").get()).toEqual({ n: 0 });
    expect(getTradeView(env.db, p.tradeId)!.trade.status).toBe('failed');
  });
  it('a mid-swap database error rolls back ALL transfers (all-or-none) and is logged', () => {
    const { env, a1, b1 } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [b1] }); if (!p.ok) throw 1;
    acceptTrade(env, p.tradeId, 'B');
    // sabotage: make the second event insert fail after the first transfer has happened
    env.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON card_events WHEN (SELECT COUNT(*) FROM card_events WHERE event='transferred') >= 1 AND NEW.event='transferred' BEGIN SELECT RAISE(ABORT,'boom'); END;`);
    expect(confirmTrade(env, p.tradeId, 'A')).toMatchObject({ ok: false });
    env.db.exec('DROP TRIGGER boom');
    expect([owner(env, a1), owner(env, b1)]).toEqual(['A', 'B']); // nothing moved
    expect(env.db.prepare('SELECT COUNT(*) n FROM failed_operations').get()).toEqual({ n: 1 });
    expect(env.db.prepare("SELECT COUNT(*) n FROM owned_cards WHERE state='reserved'").get()).toEqual({ n: 0 });
  });
  it('concurrent trades (two connections) cannot duplicate or lose a copy', () => {
    const env = makeEnv({}, true); const other = secondConnection(env);
    const a1 = give(env, 'A'); give(env, 'B'); give(env, 'C');
    const r1 = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] });
    const r2 = proposeTrade(other, { proposerId: 'A', recipientId: 'C', offerCopyIds: [a1], requestCopyIds: [] });
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(count(env)).toBe(3);
  });
  it('completed trade cannot be used to drop or re-trade the old owner’s copy', () => {
    const { env, a1 } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] }); if (!p.ok) throw 1;
    acceptTrade(env, p.tradeId, 'B'); confirmTrade(env, p.tradeId, 'A');
    expect(confirmDrop(env, 'A', a1)).toEqual({ ok: false, reason: 'not_found' });
    expect(proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a1], requestCopyIds: [] })).toMatchObject({ reason: 'not_owner' });
    expect(getProfileStats(env.db, 'A')!.uniqueOwned).toBe(1); // sender lost it, still has nagi
  });
});

describe('administration', () => {
  const admin = { userId: 'adm', isGuildAdmin: true, isOperator: false };
  it('server admins can set only allow-listed values; spawn rates / shiny odds are rejected', () => {
    const env = makeEnv();
    expect(updateGuildSetting(env, admin, 'g', 'spawn_channel_id', '123456789012345678')).toEqual({ ok: true });
    for (const k of ['shiny_odds', 'shinySpawnOdds', 'spawn_interval', 'spawn_rate', 'rarity_weights', 'daily_pack_size', 'spawn_channel_id; DROP TABLE x'])
      expect(updateGuildSetting(env, admin, 'g', k, 1)).toEqual({ ok: false, reason: 'unknown_setting' });
    expect(updateGuildSetting(env, admin, 'g', 'spawn_channel_id', "1' OR 1=1")).toEqual({ ok: false, reason: 'invalid_value' });
    expect(updateGuildSetting(env, admin, 'g', 'spawns_enabled', 'yes')).toEqual({ ok: false, reason: 'invalid_value' });
    expect(getGuildSettings(env, 'g')!.spawn_channel_id).toBe('123456789012345678');
    const cols = (env.db.prepare('PRAGMA table_info(guild_settings)').all() as { name: string }[]).map((c) => c.name);
    expect(cols.some((c) => /odds|rate|interval|weight|reward/i.test(c))).toBe(false);
  });
  it('non-admins are refused and changes are audited', () => {
    const env = makeEnv();
    expect(updateGuildSetting(env, { userId: 'x', isGuildAdmin: false, isOperator: false }, 'g', 'spawns_enabled', false)).toEqual({ ok: false, reason: 'forbidden' });
    updateGuildSetting(env, admin, 'g', 'spawns_enabled', false);
    expect(env.db.prepare("SELECT actor_id, action FROM audit_log").all()).toEqual([{ actor_id: 'adm', action: 'guild_setting_changed' }]);
  });
  it('/testspawn authorisation: unauthorised refused; admins cannot force variants; operators can', () => {
    expect(authorizeTestSpawn({ userId: 'x', isGuildAdmin: false, isOperator: false })).toEqual({ ok: false });
    expect(authorizeTestSpawn(admin)).toEqual({ ok: true, mayOverride: false });
    expect(authorizeTestSpawn({ userId: 'op', isGuildAdmin: false, isOperator: true })).toEqual({ ok: true, mayOverride: true });
  });
  it('admin test grants are labelled, audited and removable', () => {
    const env = makeEnv();
    const id = adminGrantTestCard(env, 'op', '1', 'isagi_001', 'shiny', 'qa');
    expect(env.db.prepare('SELECT source FROM owned_cards WHERE id=?').get(id)).toEqual({ source: 'admin_test' });
    expect(adminRemoveTestCards(env, 'op', '1', 'cleanup')).toBe(1);
    expect(count(env)).toBe(0);
    expect(env.db.prepare('SELECT COUNT(*) n FROM audit_log').get()).toEqual({ n: 2 });
  });
  it('migrations stay idempotent after use', () => { expect(migrate(makeEnv().db).to).toBe(1); });
});

describe('regression: set completion with duplicates', () => {
  it('owning duplicates of some set cards does not break completion detection', () => {
    const env = makeEnv(); seedQuests(env);
    const genesis = (env.db.prepare("SELECT id FROM card_definitions WHERE set_id='genesis'").all() as { id: string }[]).map((r) => r.id);
    for (const id of genesis) { give(env, '1', id); give(env, '1', id); give(env, '1', id); }
    expect(evaluateMilestones(env, '1').map((x) => x.questId)).toContain('set_genesis');
  });
});

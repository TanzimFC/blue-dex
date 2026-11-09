# Release checklist — what is verified and what is NOT

Legend: ✅ verified by automated test/script in the build sandbox · 🟡 implemented, only type-checked (needs live Discord) · ❌ not done

## Acceptance criteria (spec §16)
| # | Criterion | Status | Evidence / gap |
|---|---|---|---|
| 1 | Encounter → catch → correct copy awarded | ✅ domain / 🟡 UI | `attemptCatch` tests; button+modal flow not run against Discord |
| 2 | One variant per spawn; shiny hidden until catch | ✅ | spawn-message spec identical for both variants and free of variant strings; `PublicSpawn` has no variant; catalogue rejects leaking URLs. 🟡 *image content itself* must be reviewed by a human when real art is added |
| 3 | Expires at 180 s, never claimable after | ✅ | boundary tests at 179 999 / 180 000 ms, DB CHECK constraints, restart recovery |
| 4 | Racing players: one winner | ✅ | two-connection test, 300×20 burst (0 double wins). 🟡 true multi-*process* contention not exercised (single process by design) |
| 5 | Spawn art ≠ card art, variants independent | ✅ | separate columns/refs; validated in catalogue |
| 6 | Collection commands reflect current ownership | ✅ queries / 🟡 rendering | completion/dex/list/profile query tests |
| 7 | /drop confirm, permanent, one eligible copy | ✅ domain / 🟡 buttons | preview/confirm/lock/repeat/replay tests |
| 8 | Daily/weekly not duplicable | ✅ | UTC boundaries, repeat + two-connection tests, DB unique constraint |
| 9 | Trades atomic | ✅ | all-or-none incl. injected mid-swap failure, replay, concurrent, expiry/cancel release |
| 10 | Admins cannot change odds/rates/rewards | ✅ | allow-list test, schema has no such columns, no command option exposes them |
| 11 | Backups restore | ✅ in sandbox / ❌ on VPS | `npm run db:restore-test` 10/10. **Repeat on the target VPS with a real backup before launch** |
| 12 | Tests pass; survives restart + bursts | ✅ 68/68; restart recovery tested; burst run clean | capacity on target VPS **not measured** |
| 13 | Clean-environment deploy works | ❌ | README written but not executed on a fresh VPS |

## Bugs found and fixed while building (kept as regression tests)
1. `systemRng.float()` threw on every call (`randomInt` range limit) — would have crashed every real spawn; unit tests with the seeded RNG missed it. Now covered by production-RNG tests.
2. Set-completion milestone miscounted when the player held duplicates (join inflated the set size).

## Not verified / known limitations
- ❌ Nothing has run against the live Discord API: modal/button/autocomplete flows, embeds rendering, `/setup` permission probe, message edits, rate-limit behaviour (discord.js queues REST calls). Run a staging server smoke test: catch (normal+shiny via `/testspawn` as operator), drop, trade, daily, setup with a channel lacking permissions.
- ❌ Real artwork: `assets/` contains generated placeholders. Human review required that normal/shiny spawn images are not distinguishable by any badge.
- 🟡 Odds, rarity weights, intervals are **development placeholders** (shiny 2 %, pack shiny 1 %); the operator must decide real values.
- Load numbers (≈1 600 ops/s, p99 ≈ 2 ms/op, event-loop p99 ≈ 34 ms, RSS ≈ 170 MB incl. test harness) are from the build sandbox, not the 1 GB VPS. No public capacity claim should be made until `npm run load-test` is run there. `leaderboard()` aggregates all collectors on each call; add a short cache if it becomes slow with many players.
- In-memory only (safe to lose on restart): guess limiter, command throttle, pagination view state, per-guild "next spawn" timers/activity counters.
- Admin test-card grant/removal is CLI-only (`npm run ops`), deliberately not a Discord command.

## Interpretations of the spec (please confirm or correct)
- Catch interaction = **Catch button → modal** (needs no privileged intent). Spawn activity is counted from `GuildMessages` events (no message content).
- `/trade` command added (the §4 list omits it but §7 requires trading). Two-step: recipient **accepts**, proposer **confirms final exchange**; offered copies reserved at proposal, requested copies reserved at accept; max 5 cards/side, 3 open outgoing trades, 15-minute expiry. Locking a reserved card before confirmation fails the trade.
- The card definition awarded is chosen at spawn creation (rarity-weighted among the character's available cards) and stored with the spawn.
- Discard **deletes** the copy row; history lives in `card_events`. Favorites are cleared on transfer; locks are cleared too (new owner decides).
- Milestones (first catch, 5/15 unique, set complete) are included; no currencies ⇒ no `economy_ledger` table.
- `/profile public:false` hides a profile and excludes the player from `/leaderboard`.
- Not implemented per exclusions: awakening, streaks, marketplace, paid anything, dashboards.

## Pre-launch steps
1. Replace placeholder art; human-check spawn-art parity. 2. Set real odds in env/`gameplay.ts`. 3. Staging smoke test on Discord.
4. Deploy on the VPS, run `db:restore-test`, restore one real backup to a scratch path, run `load-test`, record numbers. 5. Off-box backup copy configured.
6. Security review: `.env` mode 600, token rotated if ever pasted anywhere, OPERATOR_IDS minimal.

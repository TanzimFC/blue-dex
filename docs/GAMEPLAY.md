# Gameplay rules, configuration, and what server admins can change

## Fixed rules (code constants, not configurable)
- A spawn = exactly one character, exactly one variant (normal | shiny), chosen server-side, stored in `spawns.variant` **before** the message is posted.
- Catch window = **180 000 ms** from `spawns.started_at` (server clock). `CHECK (expires_at - started_at = 180000)` and
  `CHECK (caught_at < expires_at)` in the schema make a late/odd catch impossible even if app code were wrong.
- First correct guess wins via one conditional `UPDATE ... WHERE status='active' AND expires_at > now` inside `BEGIN IMMEDIATE`.
  A partial unique index on `catch_history` and a unique `(source, source_ref)` index on `owned_cards` are second and third guards.
- The spawn message builder takes a `PublicSpawn` object that has **no variant field**; colour, text, footer, button and attachment name
  (`spawn.png`) are identical for both variants. Catalogue validation rejects spawn-art URLs containing `shiny`/`normal`.

## Operator-only configuration (trusted; `src/gameplay.ts` + env)
| Setting | Default | Env override |
|---|---|---|
| Shiny probability of a **spawn** | 0.02 | `SHINY_SPAWN_ODDS` |
| Shiny probability of a **pack card** (separate mechanic) | 0.01 | `PACK_SHINY_ODDS` |
| Spawn interval window per guild | 15–40 min | `SPAWN_MIN_INTERVAL_MIN`, `SPAWN_MAX_INTERVAL_MIN` |
| Hard cap on spawns per guild per hour | 3 | `SPAWN_MAX_PER_GUILD_PER_HOUR` |
| Rarity weights (catch / pack), pack sizes, guess limits, trade limits | see file | edit `src/gameplay.ts` |

The defaults are **placeholders chosen for development**; the operator should set the real values deliberately.
The min-interval floor, per-hour cap and "one active spawn per guild" rule are enforced in `createSpawn` against the database,
not just in the scheduler.

## What server admins (Manage Server) can change
Only these, through `/setup` and `/settings` (allow-list in `src/domain/admin.ts`; anything else returns `unknown_setting`):
1. Spawn channel (validated: text channel; bot needs View, Send, Embed Links, Attach Files).
2. Spawns on/off for their server.
3. Compact images (presentation only).
Every change is written to `audit_log`. `guild_settings` has no column for odds, rates, intervals or rewards.

## `/testspawn`
Operators (`OPERATOR_IDS`) and server admins only. Spawns are flagged `is_test=1`, labelled TEST, award no card, create no profile,
and never touch statistics. Only operators may force a character/variant. Odds are never displayed.

## Rewards
- Daily key = UTC date; weekly key = Monday-00:00-UTC date. Claim = one `reward_claims` row, `UNIQUE(user, type, period)`;
  cards are only granted by the call that inserted that row (same transaction).
- Daily pack: 1 card, weekly pack: 3 cards. No streaks, no missed-day logic.
- Milestones (first catch, 5/15 unique cards, each set completed): granted once per player ever (`quest_progress` PK + unique claim),
  even if the player later drops the cards.
- No currencies exist in v1, so there is no `economy_ledger` table.

## Collection score (leaderboard)
For every **distinct** card currently owned: common 1, uncommon 2, rare 4, epic 8, legendary 16; **+2** for each distinct card owned as a shiny.
Duplicates never add score. Boards: unique cards, completion %, unique shinies, score. Private profiles are excluded.

## Ownership model
`owned_cards` is the only source of truth. Completion = distinct available card definitions currently owned / available definitions.
Lifetime catch counters are statistics only. Discard deletes the row (history kept in `card_events`).
Trade states: `pending` → `accepted` → `completed`, or `declined|cancelled|expired|failed`; reserved copies are `state='reserved'`
with `reserved_trade_id`, cannot be dropped, and can only be reserved by one trade (conditional UPDATE).
Trade flow: proposer offers (their copies are reserved) → recipient reviews both sides and accepts (their requested copies are reserved)
→ proposer confirms the final exchange → revalidation → atomic swap. A lock placed on a reserved card before confirmation fails the whole trade.

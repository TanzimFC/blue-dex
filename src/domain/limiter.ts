import type { GameplayConfig } from '../gameplay.js';

export type LimitVerdict = { allowed: true } | { allowed: false; retryAfterMs: number; scope: 'user' | 'guild' };

/**
 * In-memory anti-spam for guesses. This is a *throttle only*: it can reject a guess but can never grant anything,
 * so losing it on restart cannot corrupt ownership.
 */
export class GuessLimiter {
  private last = new Map<string, number>();
  private wrong = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();
  private guildHits = new Map<string, number[]>();
  constructor(private cfg: GameplayConfig['guess']) {}

  check(userId: string, guildId: string, now: number): LimitVerdict {
    const lock = this.lockedUntil.get(userId);
    if (lock && lock > now) return { allowed: false, retryAfterMs: lock - now, scope: 'user' };
    const last = this.last.get(userId);
    if (last !== undefined && now - last < this.cfg.minGapMs) return { allowed: false, retryAfterMs: this.cfg.minGapMs - (now - last), scope: 'user' };
    const g = (this.guildHits.get(guildId) ?? []).filter((t) => now - t < this.cfg.guildWindowMs);
    if (g.length >= this.cfg.guildMaxPerWindow) {
      this.guildHits.set(guildId, g);
      return { allowed: false, retryAfterMs: this.cfg.guildWindowMs - (now - g[0]!), scope: 'guild' };
    }
    g.push(now);
    this.guildHits.set(guildId, g);
    this.last.set(userId, now);
    if (this.last.size > 5000) this.prune(now);
    return { allowed: true };
  }

  recordWrong(userId: string, now: number): void {
    const w = (this.wrong.get(userId) ?? []).filter((t) => now - t < this.cfg.windowMs);
    w.push(now);
    this.wrong.set(userId, w);
    if (w.length >= this.cfg.maxWrongPerWindow) {
      this.lockedUntil.set(userId, now + this.cfg.lockoutMs);
      this.wrong.delete(userId);
    }
  }

  private prune(now: number): void {
    for (const [u, t] of this.last) if (now - t > this.cfg.windowMs) this.last.delete(u);
    for (const [u, t] of this.lockedUntil) if (t <= now) this.lockedUntil.delete(u);
    for (const [u, w] of this.wrong) if (w.every((t) => now - t >= this.cfg.windowMs)) this.wrong.delete(u);
  }
}

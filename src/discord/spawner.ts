import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type TextBasedChannel } from 'discord.js';
import type { Ctx } from '../context.js';
import { createSpawn, attachMessage, voidSpawn, expireDueSpawns, recoverSpawns, type SpawnRow, type CreateSpawnResult } from '../domain/spawn.js';
import { recordFailure } from '../domain/audit.js';
import type { Logger } from '../logger.js';
import type { Variant } from '../types.js';
import { artParts, resolveArt } from './art.js';
import { buildSpawnMessageSpec } from './spawnMessage.js';

interface GuildState { nextAt: number; activity: number }

export class Spawner {
  private guilds = new Map<string, GuildState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private ticker?: NodeJS.Timeout;
  constructor(private ctx: Ctx, private client: Client, private assetsDir: string, private log: Logger) {}

  start(): void {
    this.recover();
    this.ticker = setInterval(() => this.tick().catch((e) => this.log.error({ err: e }, 'spawner tick failed')), this.ctx.gameplay.spawn.tickMs);
  }
  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Called on every non-bot guild message in any channel; only counts the configured spawn channel. */
  onActivity(guildId: string, channelId: string): void {
    const s = this.ctx.db.prepare('SELECT spawn_channel_id FROM guild_settings WHERE guild_id=?').get(guildId) as { spawn_channel_id: string | null } | undefined;
    if (!s || s.spawn_channel_id !== channelId) return;
    this.state(guildId).activity++;
  }

  private state(guildId: string): GuildState {
    let st = this.guilds.get(guildId);
    if (!st) {
      const g = this.ctx.gameplay.spawn;
      st = { activity: 0, nextAt: this.ctx.clock() + g.minIntervalMs + this.ctx.rng.float() * (g.maxIntervalMs - g.minIntervalMs) };
      this.guilds.set(guildId, st);
    }
    return st;
  }

  async tick(): Promise<void> {
    const now = this.ctx.clock();
    const rows = this.ctx.db.prepare('SELECT guild_id, spawn_channel_id FROM guild_settings WHERE spawns_enabled=1 AND spawn_channel_id IS NOT NULL').all() as { guild_id: string; spawn_channel_id: string }[];
    for (const r of rows) {
      const st = this.state(r.guild_id);
      if (now < st.nextAt || st.activity < this.ctx.gameplay.spawn.minActivityMessages) continue;
      const res = await this.postSpawn(r.guild_id, r.spawn_channel_id, {});
      const g = this.ctx.gameplay.spawn;
      st.activity = 0;
      st.nextAt = this.ctx.clock() + g.minIntervalMs + this.ctx.rng.float() * (g.maxIntervalMs - g.minIntervalMs);
      if (!res.ok) this.log.info({ guildId: r.guild_id, reason: res.reason }, 'spawn skipped');
    }
  }

  /** Creates the DB spawn, then posts the Discord message. Network I/O happens outside any DB transaction. */
  async postSpawn(guildId: string, channelId: string, o: { isTest?: boolean; testOverrides?: { characterId?: string; variant?: Variant } }): Promise<CreateSpawnResult> {
    const created = createSpawn(this.ctx, { guildId, channelId, isTest: o.isTest, testOverrides: o.testOverrides });
    if (!created.ok) return created;
    const { spawn, view } = created;
    try {
      const art = resolveArt(view.spawnArtRef, this.assetsDir);
      if (art.kind === 'missing') throw new Error(`spawn art missing for ${spawn.character_id}`);
      const spec = buildSpawnMessageSpec(view);
      const parts = artParts(art, spec.imageName);
      const embed = new EmbedBuilder().setColor(spec.color).setTitle(spec.title).setDescription(spec.description).setFooter({ text: spec.footer });
      if (parts.imageUrl) embed.setImage(parts.imageUrl);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(spec.button.customId).setLabel(spec.button.label).setStyle(ButtonStyle.Primary));
      const ch = await this.client.channels.fetch(channelId);
      if (!ch || !ch.isTextBased() || !('send' in ch)) throw new Error('channel not sendable');
      const msg = await (ch as TextBasedChannel & { send: Function }).send({ embeds: [embed], components: [row], files: parts.file ? [parts.file] : [] });
      attachMessage(this.ctx.db, spawn.id, msg.id);
      this.armExpiry(spawn);
      return created;
    } catch (e) {
      voidSpawn(this.ctx.db, spawn.id); // nobody saw it => nothing may be awarded
      recordFailure(this.ctx.db, this.ctx.clock(), 'spawn_post', spawn.id, e);
      this.log.error({ err: e, spawnId: spawn.id, guildId }, 'failed to post spawn; voided');
      return { ok: false, reason: 'no_eligible_characters' };
    }
  }

  armExpiry(spawn: SpawnRow): void {
    const wait = Math.max(0, spawn.expires_at - this.ctx.clock()) + 50;
    const t = setTimeout(() => { this.timers.delete(spawn.id); void this.onExpiry(); }, wait);
    t.unref?.();
    this.timers.set(spawn.id, t);
  }

  private async onExpiry(): Promise<void> {
    const expired = expireDueSpawns(this.ctx.db, this.ctx.clock());
    for (const s of expired) await this.markMessageExpired(s);
    // timer may have fired marginally early relative to our clock: re-arm anything still active.
    const still = this.ctx.db.prepare("SELECT * FROM spawns WHERE status='active'").all() as SpawnRow[];
    for (const s of still) if (!this.timers.has(s.id)) this.armExpiry(s);
  }

  /** Restart recovery: expire overdue, void unverifiable, re-arm live. */
  recover(): void {
    const rep = recoverSpawns(this.ctx.db, this.ctx.clock());
    this.log.info({ expired: rep.expired.length, voided: rep.voided.length, resumed: rep.resumed.length }, 'spawn recovery');
    for (const s of [...rep.expired, ...rep.voided]) void this.markMessageExpired(s);
    for (const s of rep.resumed) this.armExpiry(s);
  }

  private async markMessageExpired(s: SpawnRow): Promise<void> {
    if (!s.message_id) return;
    try {
      const name = (this.ctx.db.prepare('SELECT display_name n FROM characters WHERE id=?').get(s.character_id) as { n: string }).n;
      const ch = await this.client.channels.fetch(s.channel_id);
      if (!ch || !ch.isTextBased()) return;
      const msg = await ch.messages.fetch(s.message_id);
      const e = new EmbedBuilder().setColor(0x6b7280).setTitle('It got away…').setDescription(`Nobody caught **${name}** in time.`);
      await msg.edit({ embeds: [e], components: [], attachments: [] });
    } catch (err) { this.log.warn({ err, spawnId: s.id }, 'could not edit expired spawn message'); }
  }
}
void AttachmentBuilder;

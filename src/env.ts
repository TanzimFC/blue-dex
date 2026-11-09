import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20, 'DISCORD_TOKEN missing'),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{5,25}$/, 'DISCORD_CLIENT_ID must be a snowflake'),
  OPERATOR_IDS: z.string().default(''),
  DATABASE_PATH: z.string().default('./data/bluedex.db'),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  CATALOGUE_DIR: z.string().default('./catalogue'),
  ASSETS_DIR: z.string().default('./assets'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  DEV_GUILD_ID: z.string().optional().default(''),
});
export type Env = z.infer<typeof schema> & { operatorIds: Set<string> };

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const r = schema.safeParse(src);
  if (!r.success) throw new Error('Invalid environment:\n' + r.error.issues.map((i) => ` - ${i.path.join('.')}: ${i.message}`).join('\n'));
  const operatorIds = new Set(r.data.OPERATOR_IDS.split(',').map((s) => s.trim()).filter(Boolean));
  return { ...r.data, operatorIds };
}
/** Tooling scripts only need the DB/catalogue paths, not the Discord token. */
export function loadPaths(src: NodeJS.ProcessEnv = process.env) {
  return { dbPath: src.DATABASE_PATH ?? './data/bluedex.db', backupDir: src.BACKUP_DIR ?? './backups', keep: Number(src.BACKUP_KEEP ?? 14), catalogueDir: src.CATALOGUE_DIR ?? './catalogue' };
}

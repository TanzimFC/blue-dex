import type { PublicSpawn } from '../domain/spawn.js';

export const NEUTRAL_COLOR = 0x2b6cb0; // identical for every spawn; never varies by variant or rarity
export const SPAWN_IMAGE_NAME = 'spawn.png'; // neutral attachment name; real filenames never reach Discord

export interface SpawnMessageSpec {
  title: string; description: string; color: number; footer: string;
  imageKind: 'attachment' | 'url'; imageRef: string; imageName: string;
  button: { customId: string; label: string };
}

/**
 * Pure builder. It receives PublicSpawn (which has no variant) so it cannot leak shiny status
 * through text, colour, emoji, thumbnail, or filename.
 */
export function buildSpawnMessageSpec(s: PublicSpawn, _hint: 'file' | 'url' = 'file'): SpawnMessageSpec {
  const isUrl = s.spawnArtRef.startsWith('https://');
  return {
    title: 'A wild footballer appeared!',
    description: `Who is this? Press **Catch** and type the name.\nEnds <t:${Math.floor(s.expiresAt / 1000)}:R>.`,
    color: NEUTRAL_COLOR,
    footer: s.isTest ? 'TEST SPAWN – no cards are awarded' : 'You have 3 minutes.',
    imageKind: isUrl ? 'url' : 'attachment',
    imageRef: isUrl ? s.spawnArtRef : 'attachment',
    imageName: SPAWN_IMAGE_NAME,
    button: { customId: `catch:${s.id}`, label: 'Catch' },
  };
}

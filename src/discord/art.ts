import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AttachmentBuilder } from 'discord.js';

export type Art = { kind: 'url'; url: string } | { kind: 'file'; path: string } | { kind: 'missing' };

/** Resolve a catalogue asset ref. Never throws: missing/invalid art degrades to {kind:'missing'}. */
export function resolveArt(ref: string | null | undefined, assetsDir: string): Art {
  if (!ref) return { kind: 'missing' };
  if (ref.startsWith('https://')) return { kind: 'url', url: ref };
  if (ref.startsWith('file:')) {
    const root = resolve(assetsDir);
    const p = resolve(join(root, ref.slice(5)));
    if (!p.startsWith(root + sep)) return { kind: 'missing' };
    return existsSync(p) ? { kind: 'file', path: p } : { kind: 'missing' };
  }
  return { kind: 'missing' };
}

/** Returns what to attach to an embed. Local files are always sent under a caller-chosen neutral name. */
export function artParts(art: Art, name: string): { imageUrl?: string; file?: AttachmentBuilder } {
  if (art.kind === 'url') return { imageUrl: art.url };
  if (art.kind === 'file') return { imageUrl: `attachment://${name}`, file: new AttachmentBuilder(art.path, { name }) };
  return {};
}

/** Dev tool: writes flat-colour PLACEHOLDER PNGs so a fresh checkout can spawn. Replace with original/licensed art before launch. */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w: number, h: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = rgb(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hue = (s: string, shift = 0) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return (h + shift) % 360; };
const hsl = (h: number, s: number, l: number): [number, number, number] => { const a = s * Math.min(l, 1 - l); const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; };
const assets = process.env.ASSETS_DIR ?? './assets';
const cat = loadCatalogueFiles(process.env.CATALOGUE_DIR ?? './catalogue');
const write = (ref: string, key: string, tint: number, w: number, h: number) => {
  const p = join(assets, ref.slice(5)); mkdirSync(join(p, '..'), { recursive: true });
  const base = hue(key);
  writeFileSync(p, png(w, h, (x, y) => hsl((base + tint + (y / h) * 30) % 360, 0.55, 0.35 + 0.25 * (1 - Math.hypot(x / w - 0.5, y / h - 0.5)))));
};
// Spawn placeholders differ only by a subtle tint (no badge/label) so they are not obviously distinguishable by eye.
for (const c of cat.characters) { write(c.spawnArt.normal, c.id, 0, 512, 512); write(c.spawnArt.shiny, c.id, 18, 512, 512); }
for (const c of cat.cards) { write(c.art.normal, c.id, 0, 400, 560); write(c.art.shiny, c.id, 45, 400, 560); }
console.log('placeholder art written to', assets);

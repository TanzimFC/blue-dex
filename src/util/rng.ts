import { randomInt, randomUUID } from 'node:crypto';

export interface Rng {
  float(): number; // [0,1)
  int(maxExclusive: number): number;
  shortId(len?: number): string;
  uuid(): string;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, U, 0, 1

export const systemRng: Rng = {
  float: () => randomInt(0, 2 ** 47) / 2 ** 47, // randomInt range must be < 2^48
  int: (n) => randomInt(0, n),
  shortId: (len = 8) => {
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
    return s;
  },
  uuid: () => randomUUID(),
};

/** Deterministic RNG for tests only. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  let idCounter = 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int: (n) => Math.floor(next() * n),
    shortId: (len = 8) => {
      let s = '';
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      return s;
    },
    uuid: () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
  };
}

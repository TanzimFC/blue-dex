/** Normalise a guess/alias into a comparison key: case-, accent-, punctuation- and whitespace-insensitive. */
export function normalizeAlias(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 64);
}

export function normalizeCopyId(input: string): string {
  return input.trim().replace(/^#/, '').toUpperCase();
}

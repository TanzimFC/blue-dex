export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];
export const VARIANTS = ['normal', 'shiny'] as const;
export type Variant = (typeof VARIANTS)[number];
export type Clock = () => number; // epoch ms, server-side

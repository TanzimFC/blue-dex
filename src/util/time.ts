/** All reset logic is UTC. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function nextUtcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
/** Weeks run Monday 00:00 UTC -> next Monday 00:00 UTC. Key is the Monday's date. */
export function utcWeekStart(ms: number): number {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}
export function utcWeekKey(ms: number): string {
  return 'W' + new Date(utcWeekStart(ms)).toISOString().slice(0, 10);
}
export function nextUtcWeekStart(ms: number): number {
  return utcWeekStart(ms) + 7 * 86_400_000;
}
export const discordTs = (ms: number, style: 'R' | 'F' | 't' | 'f' = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

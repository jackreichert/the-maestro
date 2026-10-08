/** Tab state in the URL fragment, and arrow-key movement. Pure and DOM-free. */

export const OVERVIEW = 'overview';

/** The tab ids for a state: overview, then each stream. */
export function tabIds(streams: string[]): string[] {
  return [OVERVIEW, ...streams.filter((s) => s !== OVERVIEW)];
}

/** The summary tiles that filter the board: asks (need you), blocked, done (shipped today), working (in flight). */
export const CUE_KEYS = ['asks', 'blocked', 'done', 'working'] as const;
export type CueKey = typeof CUE_KEYS[number];

/** The `show=` value of a fragment, or null for none or anything that is not a tile key. */
export function parseFilter(hash: string): CueKey | null {
  const value = hash.replace(/^#/, '').split('&').find((part) => part.startsWith('show='))?.slice(5);
  return CUE_KEYS.find((k) => k === value) ?? null;
}

/** Read the active tab from a `location.hash` value; anything unknown falls back to overview. A `&show=...` part is ignored here. */
export function parseFragment(hash: string, ids: string[]): string {
  let raw = hash.replace(/^#/, '').split('&')[0];
  if (raw.startsWith('tab=')) raw = raw.slice(4);
  try { raw = decodeURIComponent(raw); } catch { return OVERVIEW; }
  return ids.includes(raw) ? raw : OVERVIEW;
}

/** The fragment (with the leading #) that selects a tab, and a tile filter when there is one: `#tab=ops&show=blocked`. */
export function formatFragment(id: string, filter: CueKey | null = null): string {
  return `#tab=${encodeURIComponent(id)}${filter ? `&show=${filter}` : ''}`;
}

/** The tab an arrow/Home/End key moves to, or null for any other key. Wraps at the ends. */
export function nextTab(key: string, ids: string[], current: string): string | null {
  const i = Math.max(0, ids.indexOf(current));
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return null;
}

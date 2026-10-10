/** Tab state in the URL fragment, and arrow-key movement. Pure and DOM-free. */

/** The landing tab: read-only charts and lists across every stream. */
export const DASHBOARD = 'dashboard';
/** The Board tab. Its id stays `overview` so old `#tab=overview` links keep working; only its label changed. */
export const OVERVIEW = 'overview';
/** Tab ids a stream may not take. A stream with one of these names gets a prefixed id instead (`flow` is reserved for the Flow tab). */
const RESERVED = [DASHBOARD, OVERVIEW, 'flow'];
const STREAM_PREFIX = 'stream:';

/** Both all-streams tabs: the header scopes them to every stream. */
export const isAllStreams = (id: string): boolean => id === DASHBOARD || id === OVERVIEW;

/** The tab id for a stream: its name, unless the name is reserved. */
export function streamTabId(stream: string): string {
  return RESERVED.includes(stream) ? `${STREAM_PREFIX}${stream}` : stream;
}

/** The stream a tab id shows, or null for an all-streams tab. The inverse of `streamTabId`. */
export function tabStream(id: string): string | null {
  if (isAllStreams(id)) return null;
  return id.startsWith(STREAM_PREFIX) ? id.slice(STREAM_PREFIX.length) : id;
}

/** The tab ids for a state: Dashboard, Board, then each stream. */
export function tabIds(streams: string[]): string[] {
  return [DASHBOARD, OVERVIEW, ...streams.map(streamTabId)];
}

/** The summary tiles that filter the board: asks (need you), blocked, done (shipped today), working (in flight). */
export const CUE_KEYS = ['asks', 'blocked', 'done', 'working'] as const;
export type CueKey = typeof CUE_KEYS[number];

/** A tile's DOM id. A live redraw refocuses the pressed control by id (keep-view's focusKeyOf), so tiles need stable ones. */
export function tileId(key: CueKey): string { return `tile-${key}`; }

/** The "Show everything" button's id, for the same reason. Only one filtered view is on the page at a time. */
export const CLEAR_FILTER_ID = 'clear-filter';

/** The `show=` value of a fragment, or null for none or anything that is not a tile key. */
export function parseFilter(hash: string): CueKey | null {
  const value = hash.replace(/^#/, '').split('&').find((part) => part.startsWith('show='))?.slice(5);
  return CUE_KEYS.find((k) => k === value) ?? null;
}

/** Read the active tab from a `location.hash` value; anything unknown falls back to the dashboard. A `&show=...` part is ignored here. */
export function parseFragment(hash: string, ids: string[]): string {
  let raw = hash.replace(/^#/, '').split('&')[0];
  if (raw.startsWith('tab=')) raw = raw.slice(4);
  try { raw = decodeURIComponent(raw); } catch { return DASHBOARD; }
  return ids.includes(raw) ? raw : DASHBOARD;
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

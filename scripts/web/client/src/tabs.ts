/** Tab state in the URL fragment, and arrow-key movement. Pure and DOM-free. */

/** The landing tab. Its id stays `dashboard`, so old `#tab=dashboard` links keep working. */
export const DASHBOARD = 'dashboard';
/** The retired Board tab. Old `#tab=overview` links open Home; the id stays reserved so a stream cannot take it. */
export const OVERVIEW = 'overview';
/** The Open PRs tab: every open PR grouped by repo. All-streams, so no stream may take its id either. */
export const OPEN_PRS = 'open-prs';
/** The Others' PRs tab: teammates' PRs with the drafted review comments waiting for approval. All-streams, so no stream may take its id either. */
export const OTHERS_PRS = 'others-prs';
/** The Scripts tab: the catalog of scripts the Podium can run. All-streams, so no stream may take its id either. */
export const SCRIPTS = 'scripts';
/** Tab ids a stream may not take. A stream with one of these names gets a prefixed id instead (`flow` is reserved for the Flow tab). */
const RESERVED = [DASHBOARD, OVERVIEW, OPEN_PRS, OTHERS_PRS, SCRIPTS, 'flow'];
const STREAM_PREFIX = 'stream:';

/** Home, Open PRs, Others' PRs and Scripts are not stream tabs. The header scopes them to every stream. */
export const isAllStreams = (id: string): boolean => id === DASHBOARD || id === OPEN_PRS || id === OTHERS_PRS || id === SCRIPTS;

/** The tab id for a stream: its name, unless the name is reserved. */
export function streamTabId(stream: string): string {
  return RESERVED.includes(stream) ? `${STREAM_PREFIX}${stream}` : stream;
}

/** The stream a tab id shows, or null for Home. The inverse of `streamTabId`. */
export function tabStream(id: string): string | null {
  if (isAllStreams(id)) return null;
  return id.startsWith(STREAM_PREFIX) ? id.slice(STREAM_PREFIX.length) : id;
}

/** The tab ids for a state: Home, Open PRs, Others' PRs, Scripts, then each stream. The old Board tab is not one of them. */
export function tabIds(streams: string[]): string[] {
  return [DASHBOARD, OPEN_PRS, OTHERS_PRS, SCRIPTS, ...streams.map(streamTabId)];
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

/** The `stream=` value of a fragment (the stream chip pressed on the needs-you view), or null for none or an undecodable one. */
export function parseStreamFilter(hash: string): string | null {
  const value = hash.replace(/^#/, '').split('&').find((part) => part.startsWith('stream='))?.slice(7);
  if (!value) return null;
  try { return decodeURIComponent(value) || null; } catch { return null; }
}

/** Read the active tab from a `location.hash` value. The retired Board id opens Home. Anything else unknown falls back to Home. */
export function parseFragment(hash: string, ids: string[]): string {
  let raw = hash.replace(/^#/, '').split('&')[0];
  if (raw.startsWith('tab=')) raw = raw.slice(4);
  try { raw = decodeURIComponent(raw); } catch { return DASHBOARD; }
  if (raw === OVERVIEW) return DASHBOARD;
  return ids.includes(raw) ? raw : DASHBOARD;
}

/** The `draft=` value of a fragment (a draft id the Home cue links to), or null for none or anything that is not a draft id. */
export function parseDraftFocus(hash: string): string | null {
  const value = hash.replace(/^#/, '').split('&').find((part) => part.startsWith('draft='))?.slice(6);
  return value && /^dr-[0-9a-f]{8}$/.test(value) ? value : null;
}

/** The fragment of the Others' PRs tab opened on one draft's card: `#tab=others-prs&draft=dr-0123abcd`. */
export const draftFragment = (id: string): string => `${formatFragment(OTHERS_PRS)}&draft=${id}`;

/** The fragment (with the leading #) that selects a tab, a tile filter when there is one, and a stream chip on the asks view: `#tab=dashboard&show=asks&stream=ops`. */
export function formatFragment(id: string, filter: CueKey | null = null, stream: string | null = null): string {
  const chip = filter === 'asks' && stream ? `&stream=${encodeURIComponent(stream)}` : '';
  return `#tab=${encodeURIComponent(id)}${filter ? `&show=${filter}` : ''}${chip}`;
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

/**
 * Which of today's priorities are done, and which of them became done just now.
 *
 * A priority is done when its stream has finished something today and has nothing left open: no asks, nothing in flight
 * or stale, nothing queued, nothing blocked (the footer row the Podium already carries). A priority with no stream has no
 * ledger to judge it by, so it is never done. There is no new write path: closing the work on the ledger is the event.
 *
 * Celebrating is a one-shot, so what was already done is remembered. The remembered set lives in a small store (the page
 * keeps it in localStorage) and is compared on every draw: only a priority that was listed and not done at the last view
 * is fresh. The first view ever, a reload and a live redraw of unchanged state celebrate nothing. A priority that is added
 * already done is not a transition, and a first view on a new day counts what was finished since the last view.
 * Pure apart from the store the caller hands in; no DOM.
 */
import { splitStream } from './glance.ts';
import type { DoneItem, FooterRow, Priority } from './types.ts';

export interface PriorityStatus { key: string; stream: string; done: boolean; /** ISO time the stream's latest item closed; empty when unknown. */ doneAt: string }

/** The celebration plays for about this long (the keyframes in priority-celebrate.ts run 1.4 s at most; keep this at least as long); a redraw inside it replays the card rather than cutting it short. */
export const CELEBRATE_MS = 1600;

const keyOf = (text: string, stream: string): string => `${stream}\n${text}`;

/** The key a priority is remembered by: its stream and its text, so a reorder does not make it new. */
export function priorityKey(p: Priority): string { const s = splitStream(p); return keyOf(s.text, s.stream); }
const open = (r: FooterRow): number => r.asks + r.working + (r.stale ?? 0) + r.queued + r.blocked;

/** One status per priority, in list order. */
export function priorityStatuses(items: Priority[], footer: FooterRow[], done: DoneItem[]): PriorityStatus[] {
  return items.map((p) => {
    const { text, stream } = splitStream(p);
    const row = stream ? footer.find((r) => r.stream === stream) : undefined;
    const isDone = row !== undefined && row.done > 0 && open(row) === 0;
    const times = isDone ? done.filter((d) => d.stream === stream).map((d) => Date.parse(d.closedAt)).filter(Number.isFinite) : [];
    return { key: keyOf(text, stream), stream, done: isDone, doneAt: times.length ? new Date(Math.max(...times)).toISOString() : '' };
  });
}

/** What the page does with one draw: which priorities to celebrate, how many were done before them, and whether the board just cleared. */
export interface Celebration { fresh: Set<string>; before: number; cleared: boolean; announce: string }

export interface SeenStore { read(): string | null; write(value: string): void }

interface Seen { day: string; listed: string[]; done: string[]; cleared: boolean }

function parse(raw: string | null): Seen | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Seen>;
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');
    return typeof v.day === 'string' && strings(v.listed) && strings(v.done) ? { day: v.day, listed: v.listed, done: v.done, cleared: v.cleared === true } : null;
  } catch { return null; }
}

/** The page's store: localStorage under one key, silent when storage is unavailable (private mode, a blocked profile). */
export function localSeenStore(key = 'maestro.podium.priorities-seen'): SeenStore {
  return {
    read: () => { try { return localStorage.getItem(key); } catch { return null; } },
    write: (v) => { try { localStorage.setItem(key, v); } catch { /* nothing remembered, so nothing is replayed less; the next load baselines */ } },
  };
}

/** The words a screen reader hears when something is done. */
function announcement(statuses: PriorityStatus[], fresh: Set<string>, cleared: boolean): string {
  if (fresh.size === 0) return '';
  const n = statuses.filter((s) => s.done).length;
  if (cleared) return `Board cleared. All ${statuses.length} priorities are done.`;
  const names = statuses.filter((s) => fresh.has(s.key)).map((s) => s.stream);
  return `${names.join(' and ')} done. ${n} of ${statuses.length} priorities done.`;
}

/**
 * Compares each draw's statuses with the last view's. Call `observe` once per draw of the priorities (a live redraw calls
 * it again): it records what it saw, so the same transition is never reported twice, except that a draw within CELEBRATE_MS
 * of the transition still reports it so the animation is not cut short.
 */
export function createCelebrator(store: SeenStore): { observe(day: string, statuses: PriorityStatus[], now?: number): Celebration } {
  const marked = new Map<string, number>();
  let clearedAt = -Infinity;
  return {
    observe(day, statuses, now = Date.now()) {
      const prev = parse(store.read());
      const doneKeys = statuses.filter((s) => s.done).map((s) => s.key);
      const allDone = statuses.length > 0 && doneKeys.length === statuses.length;
      const known = prev === null ? null : prev.day === day ? prev : { ...prev, listed: [], done: [], cleared: false };
      if (known !== null) {
        const wasDone = new Set(known.done);
        const wasListed = new Set(known.listed);
        const newDay = prev?.day !== day;
        for (const k of doneKeys) if (!wasDone.has(k) && (newDay || wasListed.has(k))) marked.set(k, now);
        if (allDone && !known.cleared && doneKeys.some((k) => marked.get(k) === now)) clearedAt = now;
      }
      for (const [k, at] of marked) if (now - at >= CELEBRATE_MS || !doneKeys.includes(k)) marked.delete(k);
      const fresh = new Set(marked.keys());
      const cleared = allDone && fresh.size > 0 && now - clearedAt < CELEBRATE_MS;
      store.write(JSON.stringify({ day, listed: statuses.map((s) => s.key), done: doneKeys, cleared: allDone } satisfies Seen));
      return { fresh, before: doneKeys.length - fresh.size, cleared, announce: announcement(statuses, fresh, cleared) };
    },
  };
}

/** "3:42 pm ET" for an ISO time in `tz`; empty when the time cannot be read. An Eastern zone abbreviation reads as ET, whichever side of daylight time. */
export function doneClock(iso: string, tz: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).formatToParts(new Date(at));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const zone = get('timeZoneName').replace(/^E[DS]T$/, 'ET');
    return `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()} ${zone}`.trim();
  } catch { return ''; }
}

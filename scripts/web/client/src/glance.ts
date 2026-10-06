/** The cue line (what Jack must see in two seconds), relative ages and clock times. Pure and DOM-free. */
import type { PodiumState } from './types.ts';

/** One part of the cue line: a count, the words after it, and the tone it earns when it is not zero. */
export interface CuePart { key: 'asks' | 'blocked' | 'done' | 'working'; n: number; label: string; tone: 'accent' | 'critical' | 'success' | 'neutral' }

/** The cue line in reading order: what needs you, what is blocked, what shipped today, what is in flight. */
export function cueParts(st: Pick<PodiumState, 'asks' | 'blocked' | 'done' | 'working'>): CuePart[] {
  return [
    { key: 'asks', n: st.asks.length, label: st.asks.length === 1 ? 'needs you' : 'need you', tone: 'accent' },
    { key: 'blocked', n: st.blocked.length, label: 'blocked', tone: 'critical' },
    { key: 'done', n: st.done.length, label: 'shipped today', tone: 'success' },
    { key: 'working', n: st.working.length, label: 'in flight', tone: 'neutral' },
  ];
}

const MINUTE = 60_000;

/** How long ago `since` was at `now`, compactly ("just now", "38 min", "3 h", "2 d"); empty when either time is unreadable. */
export function ago(since: string, now: string): string {
  const a = Date.parse(since);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const min = Math.max(0, Math.floor((b - a) / MINUTE));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** A wall-clock time like "2:05 pm" in `tz`; empty when the time is unreadable, and the browser's zone when `tz` is not one. */
export function clockTime(iso: string, tz: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  let text: string;
  try {
    text = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || undefined }).format(t);
  } catch {
    text = new Intl.DateTimeFormat('en-US', opts).format(t);
  }
  return text.replace(/\s?([AP])M$/, (_, x: string) => ` ${x.toLowerCase()}m`);
}

/** A calendar date like "Tuesday 6 October" for a `YYYY-MM-DD` day; empty when it is not one. */
export function longDate(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const t = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(t)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).formatToParts(t);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** Past this many minutes a live page is flagged stale: the Markdown Podium refreshes every 10, so 15 means a missed refresh. */
export const STALE_MINUTES = 15;

/** How old the data is at `nowMs`, as ago() text, and whether that is past STALE_MINUTES. Unreadable times are never stale. */
export function freshness(generatedAt: string, nowMs: number): { age: string; stale: boolean } {
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return { age: '', stale: false };
  return { age: ago(generatedAt, new Date(nowMs).toISOString()), stale: nowMs - t > STALE_MINUTES * MINUTE };
}

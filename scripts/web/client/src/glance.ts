/** The cue line (what Jack must see in two seconds), relative ages and clock times. Pure and DOM-free. */
import type { CueKey } from './tabs.ts';
import type { PodiumState } from './types.ts';

/** One part of the cue line: a count, the words after it, and the tone it earns when it is not zero. */
export interface CuePart { key: CueKey; n: number; label: string; tone: 'accent' | 'critical' | 'success' | 'neutral' }

/** The four buckets the cue line counts. */
export type Buckets = Pick<PodiumState, CueKey>;

/** The buckets for one scope: every stream when `stream` is null, otherwise that stream's items. The one place a tab scopes them. */
export function scoped(st: Buckets, stream: string | null): Buckets {
  const pick = <T extends { stream: string }>(xs: T[]): T[] => (stream === null ? xs : xs.filter((x) => x.stream === stream));
  return { asks: pick(st.asks), blocked: pick(st.blocked), done: pick(st.done), working: pick(st.working) };
}

/** The cue line in reading order: what needs you, what is blocked, what shipped today, what is in flight. */
export function cueParts(st: Buckets): CuePart[] {
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

/** Noon UTC on a real `YYYY-MM-DD` day, or NaN: the date must survive a round trip, so 2026-02-30 is rejected, not rolled into March. */
function calendarNoon(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Number.NaN;
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? t : Number.NaN;
}

/** `day` formatted as "<weekday> <day> <month>" with the given name lengths; empty when it is not a real day. */
function dayMonth(day: string, names: 'long' | 'short'): string {
  const t = calendarNoon(day);
  if (!Number.isFinite(t)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: names, day: 'numeric', month: names, timeZone: 'UTC' }).formatToParts(t);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** A calendar date like "Tuesday 6 October" for a `YYYY-MM-DD` day; empty when it is not one. */
export const longDate = (day: string): string => dayMonth(day, 'long');

/** A short calendar date like "Tue 6 Oct" for a `YYYY-MM-DD` day, for narrow screens; empty when it is not one. */
export const shortDate = (day: string): string => dayMonth(day, 'short');

/** Past this many minutes a live page is flagged stale: the Markdown Podium refreshes every 10, so 15 means a missed refresh. */
export const STALE_MINUTES = 15;

/** How old the data is at `nowMs`, as ago() text, and whether that is past STALE_MINUTES. Unreadable times are never stale. */
export function freshness(generatedAt: string, nowMs: number): { age: string; stale: boolean } {
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return { age: '', stale: false };
  return { age: ago(generatedAt, new Date(nowMs).toISOString()), stale: nowMs - t > STALE_MINUTES * MINUTE };
}

/** An ask's age for its row: "today", then whole days ("1 d", "5 d"). Negative or unreadable ages read as today. */
export function askAge(days: number): string {
  return Number.isFinite(days) && days >= 1 ? `${Math.floor(days)} d` : 'today';
}

/** Asks oldest first (most days waiting, then earliest asked), so the longest wait leads the list. A copy; stable for ties. */
export function oldestFirst<T extends { ageDays: number; ts: string }>(asks: T[]): T[] {
  const at = (t: string): number => { const n = Date.parse(t); return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY; };
  return asks.map((a, i) => ({ a, i })).sort((x, y) => (y.a.ageDays - x.a.ageDays) || (at(x.a.ts) - at(y.a.ts)) || (x.i - y.i)).map((x) => x.a);
}

/** The browser tab's title: "(n) Podium" while n asks need you, plain "Podium" otherwise. Blocked never counts: it is not your hand. */
export function cueTitle(asks: number): string {
  return Number.isInteger(asks) && asks > 0 ? `(${asks}) Podium` : 'Podium';
}

/** A tempo marking for the scope the cue line shows, and the language it is in (for `lang`, so it is pronounced right). */
export interface Tempo { word: 'Tacet' | 'Adagio' | 'Andante' | 'Allegro' | 'Presto'; lang: 'la' | 'it' }

/**
 * How much is waiting on you, as a tempo: a = open asks, b = blocked, w = in flight. Nothing at all is Tacet (the part
 * is silent); only work in flight is Adagio; one or two waiting is Andante; three to five is Allegro; six or more, or
 * three blocked, is Presto. The cue line stays the source of truth; this is the same fact in a word.
 */
export function tempoWord(counts: { asks: number; blocked: number; working: number }): Tempo {
  const waiting = counts.asks + counts.blocked;
  if (waiting === 0) return counts.working === 0 ? { word: 'Tacet', lang: 'la' } : { word: 'Adagio', lang: 'it' };
  if (waiting >= 6 || counts.blocked >= 3) return { word: 'Presto', lang: 'it' };
  return { word: waiting <= 2 ? 'Andante' : 'Allegro', lang: 'it' };
}

/** The tempo scale in order, each word with what it means: the disclosure under the cue line is built from this. */
export const TEMPO_SCALE: { word: Tempo['word']; lang: Tempo['lang']; meaning: string }[] = [
  { word: 'Tacet', lang: 'la', meaning: 'nothing' },
  { word: 'Adagio', lang: 'it', meaning: 'only work in flight' },
  { word: 'Andante', lang: 'it', meaning: 'one or two' },
  { word: 'Allegro', lang: 'it', meaning: 'three to five' },
  { word: 'Presto', lang: 'it', meaning: 'six or more, or three blocked' },
];

/** The opening of the tempo disclosure, before the scale. */
export const TEMPO_LEAD = 'Tempo reads how much is waiting on you: ';

/** What the tempo disclosure says, as one sentence. */
export const TEMPO_RULE = `${TEMPO_LEAD}${TEMPO_SCALE.map((t) => `${t.word}, ${t.meaning}`).join('; ')}.`;

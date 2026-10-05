/**
 * Today's priorities: a small file, `<status dir>/priorities.md`, that the user or the orchestrator writes.
 *
 *   date: 2026-10-05
 *   - First priority
 *   - Second priority | StreamName
 *
 * One priority per line; an optional ` | Stream` suffix maps it to a stream so the status page can count that
 * stream's asks and PRs beside it. A file whose date is not today is stale: it counts as not set, and the page and
 * `journal.ts prime` say so, so the orchestrator asks instead of showing yesterday's list as today's.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Priority { text: string; stream?: string }
export interface PrioritiesFile { date: string; items: Priority[] }
/** `ok` is a list dated today; `missing` has no file; `stale` has one dated another day (or with no date). */
export type PrioritiesState = { state: 'ok'; date: string; items: Priority[] } | { state: 'missing' } | { state: 'stale'; date: string };

/** The one line the page banner and `journal.ts prime` both print when today's priorities are not set. */
export const PRIORITIES_UNSET_LINE = 'Priorities not set for today — orchestrator will ask';

export const PRIORITIES_FILE = 'priorities.md';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` of `now` in the IANA zone `tz` (the system zone when empty). */
export function localDate(now: Date, tz = ''): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** One `text` or `text | Stream` argument or line body as a priority. */
export function parsePriority(raw: string): Priority {
  const cut = raw.lastIndexOf(' | ');
  const stream = cut === -1 ? '' : raw.slice(cut + 3).trim();
  const text = (cut === -1 || !stream ? raw : raw.slice(0, cut)).replace(/\s+/g, ' ').trim();
  return stream ? { text, stream } : { text };
}

/** Reads the file's text: a `date:` line and one priority per `- ` or `1. ` line. Anything else is ignored. */
export function parsePriorities(text: string): { date: string; items: Priority[] } {
  let date = '';
  const items: Priority[] = [];
  for (const line of text.split('\n')) {
    const d = line.match(/^\s*date\s*:\s*(\S+)\s*$/i);
    if (d) { date = d[1] ?? ''; continue; }
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(\S.*?)\s*$/);
    if (item) items.push(parsePriority(item[1] ?? ''));
  }
  return { date: DATE.test(date) ? date : '', items };
}

/** The file body for a list dated `date`. */
export const formatPriorities = (date: string, items: Priority[]): string =>
  `date: ${date}\n${items.map((p) => `- ${p.text}${p.stream ? ` | ${p.stream}` : ''}`).join('\n')}\n`;

/** Where the file is read: today's list, or why there is none. */
export function readPriorities(statusDir: string, today: string): PrioritiesState {
  const path = join(statusDir, PRIORITIES_FILE);
  if (!existsSync(path)) return { state: 'missing' };
  const { date, items } = parsePriorities(readFileSync(path, 'utf8'));
  if (date !== today || !items.length) return { state: 'stale', date };
  return { state: 'ok', date, items };
}

/** Writes today's list (temp file, then rename). Refuses an empty list or a bad date, so the file is never left meaningless. */
export function writePriorities(statusDir: string, date: string, items: Priority[]): string {
  if (!DATE.test(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  const clean = items.filter((p) => p.text);
  if (!clean.length) throw new Error('give at least one priority');
  mkdirSync(statusDir, { recursive: true });
  const path = join(statusDir, PRIORITIES_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, formatPriorities(date, clean));
  renameSync(tmp, path);
  return path;
}

/** The lines `priorities show` prints. */
export function showLines(state: PrioritiesState): string[] {
  if (state.state === 'ok') return [`Priorities for ${state.date}:`, ...state.items.map((p, i) => `${i + 1}. ${p.text}${p.stream ? ` [${p.stream}]` : ''}`)];
  return [PRIORITIES_UNSET_LINE + (state.state === 'stale' ? ` (file is dated ${state.date || 'unknown'})` : '')];
}

/**
 * This week's goals: a small file, `<status dir>/week.md`, in the same shape as priorities.md but dated by the Monday of its week.
 *
 *   date: 2026-10-05
 *   - Ship the first integration | StreamName
 *
 * A file whose date is not this week's Monday is stale: it counts as not set, so a fresh reader is told the goals need setting
 * instead of being shown last week's. Written by `journal.ts week set`, read by the Start page.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatPriorities, parsePriorities } from './priorities.ts';
import type { Priority } from './priorities.ts';

export const WEEK_FILE = 'week.md';
/** The most goals a week may hold: a week of more than this has no goals, only a list. */
export const WEEK_MAX = 7;
export const WEEK_UNSET_LINE = 'Week goals not set: ask Jack, then `journal.ts week set "<goal> | <Stream>" ...`';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type WeekState = { state: 'ok'; start: string; items: Priority[] } | { state: 'missing' } | { state: 'stale'; start: string };

/** The Monday on or before `date` (YYYY-MM-DD), as YYYY-MM-DD. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Where the file is read: this week's goals, or why there are none. */
export function readWeek(statusDir: string, today: string): WeekState {
  const path = join(statusDir, WEEK_FILE);
  if (!existsSync(path)) return { state: 'missing' };
  const { date, items } = parsePriorities(readFileSync(path, 'utf8'));
  if (date !== weekStart(today) || !items.length) return { state: 'stale', start: date };
  return { state: 'ok', start: date, items };
}

/** Writes the goals for the week containing `day` (temp file, then rename). Refuses an empty list, a bad date or a list over the cap. */
export function writeWeek(statusDir: string, day: string, items: Priority[]): string {
  if (!DATE.test(day)) throw new Error(`date must be YYYY-MM-DD, got "${day}"`);
  const clean = items.filter((p) => p.text);
  if (!clean.length) throw new Error('give at least one goal');
  if (clean.length > WEEK_MAX) throw new Error(`at most ${WEEK_MAX} goals for a week; got ${clean.length}: drop ${clean.length - WEEK_MAX}`);
  mkdirSync(statusDir, { recursive: true });
  const path = join(statusDir, WEEK_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, formatPriorities(weekStart(day), clean));
  renameSync(tmp, path);
  return path;
}

/** The goals on one line (`This week: ship it [Alpha]; fix it`), or the not-set line; what `prime` prints. */
export function weekLine(state: WeekState): string {
  if (state.state !== 'ok') return weekLines(state)[0] ?? WEEK_UNSET_LINE;
  return `This week: ${state.items.map((p) => `${p.text}${p.stream ? ` [${p.stream}]` : ''}`).join('; ')}`;
}

/** The lines `week show` prints. */
export function weekLines(state: WeekState): string[] {
  if (state.state === 'ok') return [`Goals for the week of ${state.start}:`, ...state.items.map((p, i) => `${i + 1}. ${p.text}${p.stream ? ` [${p.stream}]` : ''}`)];
  return [WEEK_UNSET_LINE + (state.state === 'stale' ? ` (file is for the week of ${state.start || 'an unknown date'})` : '')];
}

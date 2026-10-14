/**
 * wake: a durable "wake the orchestrator at T with prompt P". Target is an ISO 8601 UTC time (one-shot, `2026-10-03T15:00:00Z`)
 * or `hourly:M,M` (recurring, at those minutes past every hour UTC, for example `hourly:7,37`), or a recurring local time
 * (`weekdays@08:30 America/New_York`, `daily@08:30 America/New_York`, see lib/recurring-time.ts: once per matching local day, a loop that was
 * down fires one catch-up the same day, and the watch's lifetime renews). P is the watch's `--report`.
 * The check reads the clock and its own last state, nothing else. A recurring wake's first check only sets a baseline and
 * does not fire; after that, every slot that passed since the last check folds into one event (a quiet night is one wake,
 * not sixteen). A one-shot fires when its time has passed, then retires; a recurring wake lives until its TTL. It never
 * sends a text (`notifies = 'never'`, enforced by the loop even for a hand-edited registry), and quiet hours hold it
 * unless the watch was added with --notify-overnight. State { last, missed, text }.
 */
import type { CheckContext, WatchEvent } from '../lib/types.ts';
import { looksRecurring, parseRecurring, recurringDue } from '../lib/recurring-time.ts';
import { DEFAULT_TTL_MS } from '../lib/watch-registry.ts';
import { parseTarget } from './reminder.ts';

/** `last` is the newest recurring slot at or before the check (0 for a one-shot); `missed` is how many slots passed since the previous check. */
export interface WakeState { last: number; missed: number; text: string; oneShot: boolean; fired?: string }

export const interval = 30;
export const network = false;
export const notifies = 'never' as const;
export const backoff = false;

const HOURLY = /^hourly:(\d{1,2}(?:,\d{1,2})*)$/;
const HOUR_MS = 3600 * 1000;

/** The minutes of an `hourly:M,M` target, sorted and unique; null when the target is not that form. Throws on a minute outside 0-59. */
export function parseHourly(target: string): number[] | null {
  const m = String(target).match(HOURLY);
  if (!m) return null;
  const minutes = [...new Set(m[1].split(',').map(Number))].sort((a, b) => a - b);
  if (minutes.some((n) => n > 59)) throw new Error(`wake target "${target}" has a minute outside 0-59`);
  return minutes;
}

/** Slots (epoch ms) in the half-open span (from, to], for the given minutes. */
function slotsBetween(minutes: number[], from: number, to: number): number[] {
  const slots: number[] = [];
  for (let hour = Math.floor(from / HOUR_MS) * HOUR_MS; hour <= to; hour += HOUR_MS) {
    for (const minute of minutes) {
      const at = hour + minute * 60000;
      if (at > from && at <= to) slots.push(at);
    }
  }
  return slots;
}

/** Called by `add`: an hourly target must parse; a one-shot must be a future ISO time that its --ttl-hours does not cut short. */
export function validate(target: string, { now, ttlMs }: { now: number; ttlMs?: number }): void {
  if (parseHourly(target)) return;
  if (looksRecurring(target)) {
    if (!parseRecurring(target)) throw new Error(`wake target must look like weekdays@08:30 America/New_York or daily@08:30 America/New_York, got "${target}"`);
    return;
  }
  if (!/^\d{4}-/.test(String(target))) throw new Error(`wake target must be an ISO 8601 UTC time or hourly:M,M (for example hourly:7,37) or weekdays@HH:MM <zone>, got "${target}"`);
  const at = parseTarget(target);
  if (at <= now) throw new Error(`wake target ${target} is already in the past`);
  if (ttlMs !== undefined && now + ttlMs <= at) throw new Error('--ttl-hours would expire the wake before its target time');
}

export const defaultTtlMs = (target: string, now: number): number => (parseHourly(target) || parseRecurring(target) ? DEFAULT_TTL_MS : parseTarget(target) - now + 3 * DEFAULT_TTL_MS);

/** A recurring local-time wake is a standing watch (its expiry renews); an hourly or one-shot wake is not. */
export function renewsFor(target: string): boolean {
  try { return Boolean(parseRecurring(target)); } catch { return false; } // a bad hand-edited target fails in its own check, not in the loop
}

export function check(target: string, ctx: CheckContext): WakeState {
  const text = ctx.watch?.report ?? '';
  const rec = parseRecurring(target);
  if (rec) {
    const created = Date.parse(ctx.watch?.created ?? '');
    const { due, fired } = recurringDue(rec, ctx.now, Number.isFinite(created) ? created : ctx.now, (ctx.prev as WakeState | null | undefined)?.fired);
    return { last: 0, missed: due ? 1 : 0, text, oneShot: false, fired };
  }
  const minutes = parseHourly(target);
  if (!minutes) return { last: 0, missed: ctx.now >= parseTarget(target) ? 1 : 0, text, oneShot: true };
  const prev = ctx.prev as WakeState | null | undefined;
  // Look back a day at most: the newest slot is always within the last hour.
  const last = slotsBetween(minutes, ctx.now - DEFAULT_TTL_MS, ctx.now).at(-1) ?? 0;
  const missed = prev && typeof prev.last === 'number' ? slotsBetween(minutes, prev.last, ctx.now).length : 0;
  return { last, missed, text, oneShot: false };
}

export function diff(_prev: WakeState | null, next: WakeState): WatchEvent[] {
  if (next.missed < 1) return [];
  const label = next.text ? `wake: ${next.text}` : 'wake time reached';
  return [{ summary: next.missed > 1 ? `${label} (${next.missed} wake times passed)` : label }];
}

export const done = (state: WakeState): boolean => state.oneShot === true && state.missed > 0;

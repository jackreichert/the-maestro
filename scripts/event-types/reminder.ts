/**
 * reminder: wakes the orchestrator at a given time. Target is an ISO 8601 UTC time (`2026-10-03T15:00:00Z`, one-shot)
 * or a recurring local time (`weekdays@08:30 America/New_York`, `daily@08:30 America/New_York`; see lib/recurring-time.ts).
 * The check reads the clock and nothing else: no network, no command. When the target passes it emits one
 * actionable event whose summary carries the `--report` text. A one-shot then retires. A recurring reminder fires at most once per
 * matching local day (state remembers the day), re-arms for the next one, and renews its lifetime like a standing watch.
 * State { due, text, fired? }.
 * `add` refuses a malformed or past one-shot target, and a bad zone or time (validate), and gives a one-shot a lifetime that reaches
 * past the target (defaultTtlMs), since the usual 24 hours would expire a reminder set for next week before it fired.
 */
import type { CheckContext, Watch, WatchEvent } from '../lib/types.ts';
import { looksRecurring, parseRecurring, recurringDue } from '../lib/recurring-time.ts';

/** `due` on the tick the reminder fires; `text` is the watch's --report; `fired` is the local day a recurring reminder last fired. */
export interface ReminderState { due: boolean; text: string; fired?: string }

export const interval = 30;
export const network = false;
// Notification: on unless the watch is added with --no-notify.
export const notifies = 'default' as const;
export const backoff = false;

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
// A reminder that falls in quiet hours waits for them to end; a quiet weekend is about 60 hours, so keep it alive 3 days.
const GRACE_MS = 3 * 24 * 3600 * 1000;
// A recurring reminder's lifetime; the loop pushes it out again once under half is left.
const RECURRING_TTL_MS = 7 * 24 * 3600 * 1000;

/** Epoch milliseconds of an ISO 8601 UTC target; throws on anything else, including dates that do not exist (Feb 30). */
export function parseTarget(target: unknown): number {
  const m = String(target).match(ISO);
  if (!m) throw new Error(`reminder target must be an ISO 8601 UTC time like 2026-10-03T15:00:00Z, got "${target}"`);
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const at = new Date(String(target));
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() !== year || at.getUTCMonth() + 1 !== month || at.getUTCDate() !== day
    || at.getUTCHours() !== hour || at.getUTCMinutes() !== minute) {
    throw new Error(`reminder target "${target}" is not a real date and time`);
  }
  return at.getTime();
}

/** Called by `add`: a recurring target must parse (zone and time); a one-shot must parse, lie in the future, and not outlive an explicit --ttl-hours. */
export function validate(target: string, { now, ttlMs }: { now: number; ttlMs?: number }): void {
  if (looksRecurring(target)) {
    if (!parseRecurring(target)) throw new Error(`reminder target must look like weekdays@08:30 America/New_York or daily@08:30 America/New_York, got "${target}"`);
    return;
  }
  const at = parseTarget(target);
  if (at <= now) throw new Error(`reminder target ${target} is already in the past`);
  if (ttlMs !== undefined && now + ttlMs <= at) throw new Error('--ttl-hours would expire the reminder before its target time');
}

export const defaultTtlMs = (target: string, now: number): number => (parseRecurring(target) ? RECURRING_TTL_MS : parseTarget(target) - now + GRACE_MS);

/** A recurring reminder is a standing watch (its expiry renews); a one-shot is not. */
export const renewsFor = (target: string): boolean => Boolean(parseRecurring(target));

export function check(target: string, ctx: CheckContext): ReminderState {
  const text = ctx.watch?.report ?? '';
  const rec = parseRecurring(target);
  if (!rec) return { due: ctx.now >= parseTarget(target), text };
  const created = Date.parse(ctx.watch?.created ?? '');
  const prev = ctx.prev as ReminderState | null | undefined;
  const { due, fired } = recurringDue(rec, ctx.now, Number.isFinite(created) ? created : ctx.now, prev?.fired);
  return { due, text, fired };
}

export function diff(_prev: ReminderState | null, next: ReminderState): WatchEvent[] {
  return next.due ? [{ summary: next.text ? `reminder: ${next.text}` : 'reminder time reached' }] : [];
}

/** A one-shot retires once due; a recurring reminder never does (it expires only if it stops renewing). */
export const done = (state: ReminderState, watch?: Watch): boolean => state.due === true && !(watch && parseRecurring(watch.target));

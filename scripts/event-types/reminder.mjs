/**
 * reminder: wakes the orchestrator once at a given time. Target is an ISO 8601 UTC time (`2026-10-03T15:00:00Z`).
 * The check reads the clock and nothing else: no network, no command. When the target passes it emits one
 * actionable event whose summary carries the `--report` text, then the watch retires. State { due, text }.
 * `add` refuses a malformed or past target (validate), and gives the watch a lifetime that reaches past the target
 * (defaultTtlMs), since the usual 24 hours would expire a reminder set for next week before it fired.
 */

export const interval = 30;
export const network = false;
// Notification: on unless the watch is added with --no-notify.
export const notifies = 'default';
export const backoff = false;

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
// A reminder that fires during quiet hours waits for the morning; keep it alive for that long past the target.
const GRACE_MS = 24 * 3600 * 1000;

/** Epoch milliseconds of an ISO 8601 UTC target; throws on anything else, including dates that do not exist (Feb 30). */
export function parseTarget(target) {
  const m = String(target).match(ISO);
  if (!m) throw new Error(`reminder target must be an ISO 8601 UTC time like 2026-10-03T15:00:00Z, got "${target}"`);
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const at = new Date(target);
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() !== year || at.getUTCMonth() + 1 !== month || at.getUTCDate() !== day
    || at.getUTCHours() !== hour || at.getUTCMinutes() !== minute) {
    throw new Error(`reminder target "${target}" is not a real date and time`);
  }
  return at.getTime();
}

/** Called by `add`: the target must parse, lie in the future, and not outlive an explicit --ttl-hours. */
export function validate(target, { now, ttlMs }) {
  const at = parseTarget(target);
  if (at <= now) throw new Error(`reminder target ${target} is already in the past`);
  if (ttlMs !== undefined && now + ttlMs <= at) throw new Error('--ttl-hours would expire the reminder before its target time');
}

export const defaultTtlMs = (target, now) => parseTarget(target) - now + GRACE_MS;

export function check(target, ctx) {
  return { due: ctx.now >= parseTarget(target), text: ctx.watch?.report ?? '' };
}

export function diff(_prev, next) {
  return next.due ? [{ summary: next.text ? `reminder: ${next.text}` : 'reminder time reached' }] : [];
}

export const done = (state) => state.due === true;

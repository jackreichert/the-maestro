/**
 * Elapsed working time between two instants: the time that passed outside Saturday and Sunday in a time zone. The Others' PRs list drops a PR after
 * "two working days" without activity, so a PR quiet over a weekend is not dropped on Monday morning. Days are cut at local midnight; the hour a
 * daylight-saving change adds or removes inside a segment is not corrected for (it can move a drop by an hour, never by a day).
 */
const DAY_MS = 86_400_000;
const FORMATS = new Map<string, Intl.DateTimeFormat>();

function parts(ms: number, tz: string): { weekday: string; secondsIntoDay: number } {
  let fmt = FORMATS.get(tz);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); FORMATS.set(tz, fmt); }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday ?? '', secondsIntoDay: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}

const isWeekend = (weekday: string): boolean => weekday === 'Sat' || weekday === 'Sun';

/** Milliseconds from `from` to `to` that fall on a Monday to Friday in `tz`. Zero when `to` is not after `from`; NaN when either is not a time. */
export function workingMs(from: number, to: number, tz: string): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  let at = from;
  let total = 0;
  while (at < to) {
    const { weekday, secondsIntoDay } = parts(at, tz);
    const segmentEnd = Math.min(to, at + DAY_MS - secondsIntoDay * 1000);
    if (!isWeekend(weekday)) total += segmentEnd - at;
    at = segmentEnd;
  }
  return total;
}

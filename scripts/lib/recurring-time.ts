/**
 * recurring-time.ts: the local-clock recurring target shared by the `reminder` and `wake` event types.
 * Grammar: `weekdays@HH:MM <IANA zone>` (Monday to Friday) or `daily@HH:MM <IANA zone>`, for example `weekdays@08:30 America/New_York`.
 * The time is read in the named zone with Intl, never as a fixed UTC offset, so a daylight-saving change moves the UTC instant and not the wall clock.
 * The decision is "has today's local slot passed, and was it already fired today": no instant arithmetic, so a day with 23 or 25 hours is no special case.
 */

export interface Recurring { days: 'weekdays' | 'daily'; minutes: number; zone: string }

/** A clock reading in a zone: `day` is `YYYY-MM-DD`, `dow` 0 (Sunday) to 6, `minutes` since local midnight. */
export interface LocalParts { day: string; dow: number; minutes: number }

const RECURRING = /^(weekdays|daily)@(\d{2}):(\d{2}) (\S+)$/;
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(zone, f);
  }
  return f;
}

/** The recurring target, or null when the text is not that form. Throws on a bad time or an unknown zone, so `add` can refuse it. */
export function parseRecurring(target: string): Recurring | null {
  const m = String(target).match(RECURRING);
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) throw new Error(`recurring target "${target}" has a time outside 00:00-23:59`);
  try { formatter(m[4]); } catch { throw new Error(`recurring target "${target}" names an unknown time zone "${m[4]}" (use an IANA name like America/New_York)`); }
  return { days: m[1] as Recurring['days'], minutes: hour * 60 + minute, zone: m[4] };
}

/** True when the text looks like a recurring target (even a bad one), so validators report its own error instead of the one-shot message. */
export const looksRecurring = (target: string): boolean => /^(weekdays|daily)@/.test(String(target));

/** The wall clock in `zone` at epoch `ms`. */
export function localParts(ms: number, zone: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, dow: WEEKDAY[p.weekday as keyof typeof WEEKDAY], minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const DAY_MS = 24 * 3600 * 1000;

/** The calendar day before `day` (`YYYY-MM-DD`) and its weekday, by date arithmetic (no instants, so a 23 or 25 hour day is no special case). */
function dayBefore(day: string): { day: string; dow: number } {
  const d = new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
  return { day: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
}

/**
 * Whether the recurring slot is due at `now`. The slot is the newest one that has passed: today's if today matches the days and its time
 * has passed in the zone, else yesterday's if yesterday matched (so a slot that quiet hours held across local midnight still fires the next
 * morning, as a one-shot would). It is due when it has not fired (`firedDay` is older) and is later than the watch's creation (adding a watch
 * at 10:00 does not fire the 08:30 that already passed). A loop that was down fires the newest slot once when it returns; older ones are never
 * replayed. Returns the slot day to remember as fired.
 */
export function recurringDue(rec: Recurring, now: number, createdMs: number, firedDay: string | undefined): { due: boolean; fired: string | undefined } {
  const today = localParts(now, rec.zone);
  const matches = (dow: number): boolean => rec.days === 'daily' || (dow >= 1 && dow <= 5);
  const yesterday = dayBefore(today.day);
  const slotDay = matches(today.dow) && today.minutes >= rec.minutes ? today.day : matches(yesterday.dow) ? yesterday.day : undefined;
  if (!slotDay) return { due: false, fired: firedDay };
  const created = localParts(createdMs, rec.zone);
  const afterCreated = created.day < slotDay || (created.day === slotDay && created.minutes < rec.minutes);
  const due = afterCreated && (firedDay === undefined || firedDay < slotDay);
  return { due, fired: due ? slotDay : firedDay };
}

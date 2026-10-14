/**
 * wake-schedule.ts: the wake schedule a fresh session sees at start, and the session-cron calls that mirror it while no loop is running.
 * A wake is a watch of type `wake` whose target is an ISO time (one-shot), `hourly:7,37` or `weekdays@08:30 America/New_York` (recurring) and whose `report` is the prompt.
 * SEAM: `parseWakeTarget` is a minimal local reader of that grammar, so this file stands alone; when the `wake` type lands its own parser
 * replaces this one and nothing else here changes.
 */
import { parseRecurring } from './recurring-time.ts';
import type { Recurring } from './recurring-time.ts';
import type { Watch } from './types.ts';
import { withhold } from './withhold.ts';

export type WakeTarget = { kind: 'once'; at: number } | { kind: 'hourly'; minutes: number[] } | ({ kind: 'local' } & Recurring);

/** `hourly:7,37`, `weekdays@08:30 America/New_York` (or `daily@...`), or an ISO time; null for anything else, including a bad zone or time. */
export function parseWakeTarget(target: string): WakeTarget | null {
  try {
    const rec = parseRecurring(target);
    if (rec) return { kind: 'local', ...rec };
  } catch { return null; }
  const hourly = /^hourly:(\d{1,2}(?:,\d{1,2})*)$/.exec(target);
  if (hourly) {
    const minutes = hourly[1].split(',').map(Number);
    return minutes.every((m) => m >= 0 && m <= 59) ? { kind: 'hourly', minutes } : null;
  }
  const at = Date.parse(target);
  return Number.isFinite(at) ? { kind: 'once', at } : null;
}

const liveWakes = (watches: Watch[], now: number): Watch[] => watches.filter((w) => w.type === 'wake' && Date.parse(w.expires) > now && parseWakeTarget(w.target));

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** One line per live wake: `Wake <id>: hourly:7,37 - <prompt>`. Prompts are secret-withheld and shortened. Empty with no wakes. */
export function wakeScheduleLines(watches: Watch[], now: number): string[] {
  const lines = liveWakes(watches, now).map((w) => withhold(`Wake ${w.id}: ${w.target}${w.report ? ` - ${oneLine(w.report).slice(0, 120)}` : ''}`));
  return lines.length ? ['Wake schedule (the event loop fires these):', ...lines.map((l) => `- ${l}`)] : [];
}

const machineZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The cron expression for a target in the machine's local time (what session crons use), or '' when a one-shot is already past.
 * A `weekdays@`/`daily@` target mirrors as a local-time cron (`30 8 * * 1-5`) only when its zone is the machine's own zone: cron has no zone,
 * so a different zone would drift from the loop at every daylight-saving change, and a day boundary would shift the weekday range. Such a target
 * gets no mirror line; the event loop is the only thing that fires it.
 */
export function cronFor(target: WakeTarget, now: number, machine: string = machineZone()): string {
  if (target.kind === 'local') {
    if (target.zone !== machine) return '';
    return `${target.minutes % 60} ${Math.floor(target.minutes / 60)} * * ${target.days === 'weekdays' ? '1-5' : '*'}`;
  }
  if (target.kind === 'hourly') return `${target.minutes.join(',')} * * * *`;
  if (target.at <= now) return '';
  const d = new Date(target.at);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

/** The `CronCreate` calls that stand in for each wake. Only worth printing when no loop is running to fire the wakes. */
export function cronMirrorLines(watches: Watch[], now: number): string[] {
  const calls = liveWakes(watches, now).flatMap((w) => {
    const cron = cronFor(parseWakeTarget(w.target) as WakeTarget, now);
    return cron ? [`- CronCreate cron="${cron}" prompt=${JSON.stringify(withhold(oneLine(w.report || `wake ${w.id}`)))}${parseWakeTarget(w.target)?.kind === 'once' ? ' recurring=false' : ''}`] : [];
  });
  return calls.length ? ['The event loop is not running, so nothing fires the wakes above. Mirror them with session crons until it is back:', ...calls] : [];
}

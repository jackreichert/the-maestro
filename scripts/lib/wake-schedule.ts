/**
 * wake-schedule.ts: the wake schedule a fresh session sees at start, and the session-cron calls that mirror it while no loop is running.
 * A wake is a watch of type `wake` whose target is an ISO time (one-shot) or `hourly:7,37` (recurring) and whose `report` is the prompt.
 * SEAM: `parseWakeTarget` is a minimal local reader of that grammar, so this file stands alone; when the `wake` type lands its own parser
 * replaces this one and nothing else here changes.
 */
import type { Watch } from './types.ts';
import { withhold } from './withhold.ts';

export type WakeTarget = { kind: 'once'; at: number } | { kind: 'hourly'; minutes: number[] };

/** `hourly:7,37` or an ISO time; null for anything else. */
export function parseWakeTarget(target: string): WakeTarget | null {
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

/** The cron expression for a target in the machine's local time (what session crons use), or '' when a one-shot is already past. */
export function cronFor(target: WakeTarget, now: number): string {
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

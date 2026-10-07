/**
 * The one place that turns the heartbeat, the loop lock and the supervisor record into a verdict and a `Loop:` line.
 *
 *   ok <age>         a live writer's heartbeat is within its own planned wake time plus STALL_GRACE_MS
 *   quiet            the supervisor is waiting out quiet hours, as it said it would
 *   running          a loop holds the lock but has never written a heartbeat (started before heartbeats existed)
 *   STALLED <age>    the writer is alive but its heartbeat is past that deadline: it is hung
 *   DOWN             a supervisor is set up (or required) and nothing alive is writing
 *   NOT INSTALLED    `loop_supervisor: required` and no supervisor is set up and no loop is running
 *   absent           nothing is set up and nothing is required: no line, so an install that does not use a loop is not nagged
 */
import type { Heartbeat } from './heartbeat.ts';
import type { SupervisorStatus } from './supervisor-state.ts';

/** How long past its planned wake time a heartbeat may be before the writer counts as stalled. */
export const STALL_GRACE_MS = 5 * 60_000;

export type LoopState = 'ok' | 'quiet' | 'running' | 'stalled' | 'down' | 'not-installed' | 'absent';
export interface LoopHealth { state: LoopState; line: string }

export interface HealthInput {
  now: number;
  heartbeat: Heartbeat | null;
  /** The pid holding the loop lock, or null. */
  lockPid: number | null;
  supervisor: Pick<SupervisorStatus, 'state'>;
  /** `loop_supervisor: required` in the config. */
  required: boolean;
  alive: (pid: number) => boolean;
  tz: string;
}

const minutes = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const clock = (at: number, tz: string): string => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false }).format(at);
const tzName = (at: number, tz: string): string => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
const stamp = (at: number, tz: string): string => `${clock(at, tz)} ${tzName(at, tz)}`;
const line = (state: LoopState, text: string): LoopHealth => ({ state, line: `**Loop:** ${text}` });

/** The verdict for the inputs above. Pure: every read is passed in. */
export function loopHealth({ now, heartbeat: hb, lockPid, supervisor, required, alive, tz }: HealthInput): LoopHealth {
  if (hb && alive(hb.pid)) {
    const at = Date.parse(hb.at);
    const wake = hb.sleepingUntil ? Date.parse(hb.sleepingUntil) : at;
    if (now > Math.max(at, wake) + STALL_GRACE_MS) return line('stalled', `STALLED ${minutes(now - at)} (no heartbeat since ${stamp(at, tz)})`);
    if (hb.mode === 'quiet') return line('quiet', `quiet until ${stamp(wake, tz)}`);
    return line('ok', `ok ${minutes(now - at)}`);
  }
  if (lockPid !== null) return line('running', 'running, no heartbeat yet');
  if (supervisor.state !== 'absent') return line('down', hb ? `DOWN since ${stamp(Date.parse(hb.at), tz)}` : 'DOWN');
  if (required) return line('not-installed', 'NOT INSTALLED (loop_supervisor is required; run scripts/install-loop-supervisor.ts)');
  return { state: 'absent', line: '' };
}

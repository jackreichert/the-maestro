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
 *
 * Any non-empty line ends with ` · N unread digests` when digests were saved and no session has read them; nothing is added when there are none.
 */
import type { Heartbeat } from './heartbeat.ts';
import { CHUNK_SECONDS } from './wall-sleep.ts';
import type { SupervisorStatus } from './supervisor-state.ts';

/** How long past its planned wake time a heartbeat may be before the writer counts as stalled. */
export const STALL_GRACE_MS = 5 * 60_000;

export type LoopState = 'ok' | 'quiet' | 'running' | 'stalled' | 'down' | 'not-installed' | 'absent';
export interface LoopHealth {
  state: LoopState;
  line: string;
  /** Digests saved to the inbox that no session has read yet; present only when there are some. */
  unreadDigests?: number;
}

export interface HealthInput {
  now: number;
  heartbeat: Heartbeat | null;
  /** The pid holding the loop lock, or null. */
  lockPid: number | null;
  supervisor: Pick<SupervisorStatus, 'state' | 'pid'>;
  /** When the machine last woke from sleep (epoch ms), or null when unknown. */
  wokeAt?: number | null;
  /** `loop_supervisor: required` in the config. */
  required: boolean;
  /** Saved digests not yet shown to a session (the digest store's unseen count); omitted or 0 adds nothing to the line. */
  unreadDigests?: number;
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
/** ` · 3 unread digests`: delivered to the inbox and not yet read, which a live heartbeat says nothing about. */
const unreadSuffix = (n: number): string => ` · ${n} unread digest${n === 1 ? '' : 's'}`;

/** The verdict for the inputs above, with the unread-digest count appended to any non-empty line. Pure: every read is passed in. */
export function loopHealth(input: HealthInput): LoopHealth {
  const verdict = heartbeatVerdict(input);
  const unread = Math.max(0, Math.floor(input.unreadDigests ?? 0));
  return verdict.line && unread > 0 ? { ...verdict, line: `${verdict.line}${unreadSuffix(unread)}`, unreadDigests: unread } : verdict;
}

function heartbeatVerdict({ now, heartbeat, lockPid, supervisor, required, alive, tz, wokeAt = null }: HealthInput): LoopHealth {
  // A heartbeat counts only from the process that owns it: the lock holder for `run`, the supervisor record's pid (with no loop holding the lock) for the rest.
  // A pid that merely looks alive (reused after a reboot, or another runner) must not vouch for the loop.
  const owned = heartbeat && alive(heartbeat.pid)
    && (heartbeat.mode === 'run' ? heartbeat.pid === lockPid : lockPid === null && supervisor.state === 'running' && heartbeat.pid === supervisor.pid);
  const hb = owned ? heartbeat : null;
  if (hb) {
    const at = Date.parse(hb.at);
    const wake = hb.sleepingUntil ? Date.parse(hb.sleepingUntil) : at;
    const lateBy = now - Math.max(at, wake);
    if (hb.mode === 'backoff') return line('down', `DOWN, the loop will not start (${hb.lastError || 'no reason recorded'}); retrying, last try ${minutes(now - at)} ago`);
    if (lateBy > STALL_GRACE_MS) {
      // The lid was closed: the writer's timers did not run, and it needs up to one chunk after waking to beat again.
      if (wokeAt !== null && wokeAt > at && now - wokeAt < CHUNK_SECONDS * 1000 + STALL_GRACE_MS) return line('ok', 'ok, waking after sleep');
      return line('stalled', `STALLED ${minutes(now - at)} (no heartbeat since ${stamp(at, tz)})`);
    }
    if (hb.mode === 'quiet') return line('quiet', `quiet until ${stamp(wake, tz)}`);
    return line('ok', `ok ${minutes(now - at)}`);
  }
  if (lockPid !== null) return line('running', 'running, no heartbeat yet');
  if (supervisor.state !== 'absent') return line('down', heartbeat ? `DOWN since ${stamp(Date.parse(heartbeat.at), tz)}` : 'DOWN');
  if (required) return line('not-installed', 'NOT INSTALLED (loop_supervisor is required; run scripts/install-loop-supervisor.ts)');
  return { state: 'absent', line: '' };
}

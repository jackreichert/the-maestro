/**
 * The supervisor's hang watchdog: a loop child that is alive but has stopped writing its heartbeat is stuck (a deadlock, a wedged call), and
 * nothing else would ever restart it, since launchd only relaunches a process that exits. `createWatchdog` is the check the supervisor runs on a timer
 * for each launch; it kills the child (SIGTERM, then SIGKILL) and the supervisor's usual relaunch does the rest.
 *
 * A child is hung when now is more than HANG_GRACE_MS past the later of its last heartbeat write and the wake time it declared (`sleepingUntil`).
 * Only a `run` heartbeat from the child's own pid counts; with none yet, the launch time stands in for it. A stale reading must be seen on two
 * checks in a row: after a closed lid every timer resumes at once, and the loop needs up to a chunk to beat again, so one stale look is forgiven.
 */
import type { Heartbeat } from './heartbeat.ts';

/** How long past its declared wake time a child may be silent before it is hung. Looser than loop-health's STALLED (5 min) so the line warns before anything is killed. */
export const HANG_GRACE_MS = 10 * 60_000;
/** After SIGTERM, how long before a later check escalates to SIGKILL. */
export const KILL_AFTER_MS = 15_000;

/** The time (epoch ms) after which a child with this heartbeat counts as hung. */
export function hangDeadline({ heartbeat, childPid, launchedAt, graceMs = HANG_GRACE_MS }: { heartbeat: Heartbeat | null; childPid: number; launchedAt: number; graceMs?: number }): number {
  if (!heartbeat || heartbeat.pid !== childPid || heartbeat.mode !== 'run') return launchedAt + graceMs;
  const at = Date.parse(heartbeat.at);
  const wake = heartbeat.sleepingUntil ? Date.parse(heartbeat.sleepingUntil) : at;
  return Math.max(at, wake) + graceMs;
}

export interface WatchdogDeps {
  childPid: number;
  launchedAt: number;
  readBeat: () => Heartbeat | null;
  now: () => number;
  log: (line: string) => void;
  kill: (signal: 'SIGTERM' | 'SIGKILL') => void;
  graceMs?: number;
}

/** One launch's watchdog. `check()` returns true on the call that first sends SIGTERM. */
export function createWatchdog({ childPid, launchedAt, readBeat, now, log, kill, graceMs = HANG_GRACE_MS }: WatchdogDeps): { check: () => boolean } {
  let staleSeen = false;
  let termAt: number | null = null;
  let killed = false;
  return {
    check: () => {
      const t = now();
      if (termAt !== null) {
        if (!killed && t - termAt >= KILL_AFTER_MS) { killed = true; log(`loop pid ${childPid} ignored SIGTERM; sending SIGKILL`); kill('SIGKILL'); }
        return false;
      }
      const deadline = hangDeadline({ heartbeat: readBeat(), childPid, launchedAt, graceMs });
      if (t <= deadline) { staleSeen = false; return false; }
      if (!staleSeen) { staleSeen = true; return false; }
      termAt = t;
      log(`loop pid ${childPid} is hung (no heartbeat for ${Math.round((t - deadline + graceMs) / 60_000)} min past its wake time); sending SIGTERM`);
      kill('SIGTERM');
      return true;
    },
  };
}

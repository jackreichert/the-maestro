/** The real-world inputs for `loopHealth`: this machine's heartbeat, loop lock, supervisor record and config. Kept apart so loop-health.ts stays pure. */
import { EVENT_DIR, LOOP_SUPERVISOR_REQUIRED, WATCH_TZ } from '../local-config.ts';
import { readHeartbeat } from './heartbeat.ts';
import { loopHealth } from './loop-health.ts';
import type { LoopHealth } from './loop-health.ts';
import { supervisorStatus } from './supervisor-state.ts';
import { lockHolder } from './watch-registry.ts';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** The loop's health right now. Never throws: a broken read must not take the footer or prime down. */
export function liveLoopHealth(now: number = Date.now()): LoopHealth {
  try {
    return loopHealth({ now, heartbeat: readHeartbeat(EVENT_DIR), lockPid: lockHolder(EVENT_DIR), supervisor: supervisorStatus(EVENT_DIR), required: LOOP_SUPERVISOR_REQUIRED, alive, tz: WATCH_TZ });
  } catch { return { state: 'absent', line: '' }; }
}

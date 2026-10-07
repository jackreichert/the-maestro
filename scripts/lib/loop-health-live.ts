/** The real-world inputs for `loopHealth`: this machine's heartbeat, loop lock, supervisor record and config. Kept apart so loop-health.ts stays pure. */
import { spawnSync } from 'node:child_process';
import { EVENT_DIR, LOOP_SUPERVISOR_REQUIRED, WATCH_TZ } from '../local-config.ts';
import { readHeartbeat } from './heartbeat.ts';
import { loopHealth } from './loop-health.ts';
import type { LoopHealth } from './loop-health.ts';
import { supervisorStatus } from './supervisor-state.ts';
import { lockHolder } from './watch-registry.ts';

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** When macOS last woke from sleep, from `sysctl kern.waketime`; null elsewhere or when unreadable. */
export function lastWake(): number | null {
  try {
    const r = spawnSync('sysctl', ['-n', 'kern.waketime'], { encoding: 'utf8', timeout: 2000 });
    const sec = Number(/sec\s*=\s*(\d+)/.exec(r.stdout ?? '')?.[1]);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
  } catch { return null; }
}

/** The loop's health right now. Never throws: a broken read must not take the footer or prime down. */
export function liveLoopHealth(now: number = Date.now()): LoopHealth {
  try {
    return loopHealth({ now, heartbeat: readHeartbeat(EVENT_DIR), lockPid: lockHolder(EVENT_DIR), supervisor: supervisorStatus(EVENT_DIR), required: LOOP_SUPERVISOR_REQUIRED, alive, tz: WATCH_TZ, wokeAt: lastWake() });
  } catch { return { state: 'absent', line: '' }; }
}

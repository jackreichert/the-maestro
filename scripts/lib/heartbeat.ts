/**
 * The loop's heartbeat: `<event_dir>/heartbeat.json`, rewritten (temp file and rename) on each tick and each sleep chunk, so a
 * reader can tell a loop that is working or asleep on purpose from one that is stuck. `lib/loop-health.ts` is the one reader.
 * It carries the writer's pid, no event text.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `run`: the loop is ticking or sleeping to its next due watch. `quiet`: the supervisor is waiting out quiet hours. `idle`: the supervisor is waiting to relaunch the loop. */
export type HeartbeatMode = 'run' | 'quiet' | 'idle';

export interface Heartbeat {
  pid: number;
  /** ISO time of this write. */
  at: string;
  tick: number;
  watchesLive: number;
  /** ISO time the writer plans to be asleep until, or null when it is not asleep. */
  sleepingUntil: string | null;
  mode: HeartbeatMode;
  /** The last tick error, one line; empty when none. */
  lastError: string;
}

export const heartbeatPath = (eventDir: string): string => join(eventDir, 'heartbeat.json');

/** Writes the heartbeat atomically, so a reader never sees half of it. */
export function writeHeartbeat(eventDir: string, beat: Heartbeat): void {
  mkdirSync(eventDir, { recursive: true });
  const tmp = `${heartbeatPath(eventDir)}.${beat.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(beat));
  renameSync(tmp, heartbeatPath(eventDir));
}

const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** The heartbeat, or null when there is none or it does not have the shape written above. */
export function readHeartbeat(eventDir: string): Heartbeat | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(heartbeatPath(eventDir), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const b = raw as Partial<Heartbeat>;
    const modeOk = b.mode === 'run' || b.mode === 'quiet' || b.mode === 'idle';
    if (!(typeof b.pid === 'number' && Number.isInteger(b.pid) && b.pid > 0 && isTime(b.at) && modeOk)) return null;
    return {
      pid: b.pid, at: b.at, mode: b.mode as HeartbeatMode, tick: Number.isInteger(b.tick) ? Number(b.tick) : 0, watchesLive: Number.isInteger(b.watchesLive) ? Number(b.watchesLive) : 0,
      sleepingUntil: isTime(b.sleepingUntil) ? b.sleepingUntil : null, lastError: typeof b.lastError === 'string' ? b.lastError : '',
    };
  } catch { return null; }
}

/**
 * The waiter registry: `<event dir>/waiters/<pid>.json`, one small file per live `events wait` / `digest-wait` process.
 * A session can only hear the loop through such a waiter, and a roll or a closed terminal kills it silently; this registry
 * makes "is a waiter armed for this window?" answerable, so a hook can say so instead of the session having to remember.
 *
 * A record holds the pid, the window id (lib/window-id.ts) and the start time, no event text. A record whose pid is gone
 * (killed, crashed, rolled) is dead and is deleted when read, so the answer never rests on a file the writer failed to clean up.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Waiter { pid: number; window: string; startedAt: string }

export const waitersDir = (eventDir: string): string => join(eventDir, 'waiters');
const recordPath = (eventDir: string, pid: number): string => join(waitersDir(eventDir), `${pid}.json`);

/** Whether a process exists (EPERM means it does, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Writes this process's record (temp file and rename, so a reader never sees half of it) and returns the function that removes it. */
export function registerWaiter(eventDir: string, window: string, pid: number = process.pid, now: number = Date.now()): () => void {
  mkdirSync(waitersDir(eventDir), { recursive: true });
  const tmp = `${recordPath(eventDir, pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid, window, startedAt: new Date(now).toISOString() } satisfies Waiter));
  renameSync(tmp, recordPath(eventDir, pid));
  return () => rmSync(recordPath(eventDir, pid), { force: true });
}

function parse(file: string): Waiter | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Waiter>;
    return Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.window === 'string' && typeof v.startedAt === 'string' ? (v as Waiter) : null;
  } catch { return null; }
}

/** The waiters whose process is alive. Records of dead processes and unreadable files are deleted on the way; never throws. */
export function liveWaiters(eventDir: string, alive: (pid: number) => boolean = pidAlive): Waiter[] {
  try {
    const out: Waiter[] = [];
    for (const name of readdirSync(waitersDir(eventDir))) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = join(waitersDir(eventDir), name);
      const w = parse(file);
      if (w && w.pid === Number(name.slice(0, -5)) && alive(w.pid)) out.push(w);
      else rmSync(file, { force: true });
    }
    return out;
  } catch { return []; }
}

/** Whether a live waiter is armed for `window`. */
export const hasLiveWaiter = (eventDir: string, window: string, alive?: (pid: number) => boolean): boolean => liveWaiters(eventDir, alive).some((w) => w.window === window);

/** The line a hook prints when this window has no waiter; the command is the one that arms it. */
export const rearmLine = (command: string): string =>
  `Waiter: none armed for this session, so nothing will wake it when an event arrives. Start one now with run_in_background: ${command}`;

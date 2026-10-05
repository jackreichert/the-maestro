/**
 * The generator lock, `<statusDir>/.now.lock`: two page rebuilds never run at once. The holder's pid and the time it took
 * the lock are written to it. A second run waits for it to go, up to `timeoutMs`, then gives up with an error.
 * A lock is stale, and taken over, when its holder is gone, or when it is older than `staleMs`, which is set far above the slowest run (three gh tries and two ledger reads, each with a 2 minute limit) and only guards against a dead holder's pid being reused. A live holder is never evicted sooner: a slow GitHub must not let a second rebuild in.
 * Every outside thing (clock, sleep, "is this pid alive") is a parameter, so tests run it with no real waiting.
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = '.now.lock';

export interface LockEnv {
  nowMs(): number;
  sleep(ms: number): void;
  /** True when a process with this pid exists. */
  pidAlive(pid: number): boolean;
  pid: number;
}
export interface LockTiming { timeoutMs: number; staleMs: number; pollMs: number }
export const LOCK_TIMING: LockTiming = { timeoutMs: 10_000, staleMs: 30 * 60_000, pollMs: 250 };

interface Holder { pid: number; at: number }

/** The default pid check: signal 0 tests for existence; EPERM means it exists but is not ours. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readHolder(path: string): { raw: string; holder: Holder | null } | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const h = JSON.parse(raw) as Partial<Holder>;
    return { raw, holder: typeof h.pid === 'number' && typeof h.at === 'number' ? { pid: h.pid, at: h.at } : null };
  } catch { return { raw, holder: null }; }
}

/** Creates the lock file; false when somebody else holds it. */
function tryCreate(path: string, body: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try { writeSync(fd, body); } finally { closeSync(fd); }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Moves a stale lock out of the way. The check and the rename are two steps, so after the rename the file moved aside is read again:
 * if it is not the stale lock that was seen, a racing run had already replaced it, and it is linked back (link fails if the path is taken again).
 */
function evict(path: string, seen: string, env: LockEnv): boolean {
  if (readHolder(path)?.raw !== seen) return false;
  const aside = `${path}.stale-${env.pid}`;
  try { renameSync(path, aside); } catch { return false; }
  if (readHolder(aside)?.raw !== seen) {
    try { linkSync(aside, path); } catch { /* the path is taken again; that holder owns it */ }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

/** Takes the lock (waiting for a live holder up to the timeout) and returns the function that releases it. Throws on timeout. */
export function acquireLock(dir: string, env: LockEnv, timing: LockTiming = LOCK_TIMING): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const start = env.nowMs();
  for (;;) {
    const body = JSON.stringify({ pid: env.pid, at: env.nowMs() });
    if (tryCreate(path, body)) return () => { if (readHolder(path)?.raw === body) rmSync(path, { force: true }); };
    const found = readHolder(path);
    if (found) {
      const { holder } = found;
      const stale = !holder || !env.pidAlive(holder.pid) || env.nowMs() - holder.at > timing.staleMs;
      if (stale && evict(path, found.raw, env)) continue;
    }
    if (env.nowMs() - start >= timing.timeoutMs) {
      const who = found?.holder ? ` (pid ${found.holder.pid}, ${Math.round((env.nowMs() - found.holder.at) / 1000)} s ago)` : '';
      throw new Error(`a status page refresh is already running${who}; try again in a moment`);
    }
    env.sleep(timing.pollMs);
  }
}

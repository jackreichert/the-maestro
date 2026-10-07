/**
 * Watch registry for the event loop: an append-only JSON lines file plus a state file.
 *
 * watches.jsonl holds three kinds of line: {op:'add', id, type, target, done_when, report, created, expires,
 * notify_overnight, notify, interval, renew?}, {op:'remove', id, at, reason} and {op:'renew', id, expires, at, renew?}. A renew line with `renew: true` also marks the watch standing. The live set is the adds
 * with no later remove, each with the expiry of its latest renew, so the file is never rewritten. state.json holds each watch's last checked state and the event timestamps the
 * cadence reads; digest.jsonl holds events nobody has read yet.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestEvent, LoopState, Watch } from './types.ts';

/** Node's errno-carrying errors; `code` is what the lock logic branches on. */
const errorCode = (err: unknown): string | undefined => (err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined);

export const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const paths = (dir: string) => ({
  watches: join(dir, 'watches.jsonl'),
  state: join(dir, 'state.json'),
  digest: join(dir, 'digest.jsonl'),
});

const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const append = (file: string, obj: unknown): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
};

/** The live watches, oldest first. A corrupt line is skipped, never fatal. */
export function listWatches(dir: string): Watch[] {
  const live = new Map<string, Watch>();
  for (const line of readLines(paths(dir).watches)) {
    let rec: (Partial<Omit<Watch, 'op'>> & { op?: string }) | null;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.op === 'add' && rec.id) live.set(rec.id, rec as Watch);
    else if (rec?.op === 'remove' && rec.id !== undefined) live.delete(rec.id);
    else if (rec?.op === 'renew' && rec.id !== undefined && typeof rec.expires === 'string' && Number.isFinite(Date.parse(rec.expires))) {
      const watch = live.get(rec.id);
      if (watch) live.set(rec.id, { ...watch, expires: rec.expires, ...((rec as { renew?: unknown }).renew === true ? { renew: true } : {}) });
    }
  }
  return [...live.values()];
}

/** Appends a watch. `target` and `done_when` are the type's to interpret. Throws on a bad id or a duplicate live id. */
/** What `add` takes. The CLI passes whatever flags were given, so id, type and target are checked, not assumed; `interval` may be the CLI's string. */
export interface NewWatch {
  id?: string; type?: string; target?: string; done_when?: string; report?: string; ttlMs?: number;
  notify_overnight?: boolean; interval?: number | string | null; notify?: boolean;
  /** Standing watch: the loop keeps pushing `expires` out (see EventType.renews). */
  renew?: boolean;
}

export function addWatch(dir: string, { id, type, target, done_when = '', report = '', ttlMs = DEFAULT_TTL_MS, notify_overnight = false, interval = null, notify = false, renew = false }: NewWatch, now: number = Date.now()): Watch {
  if (id === undefined || !ID.test(id)) throw new Error(`watch id must match ${ID}, got "${id}"`);
  if (!type || !target) throw new Error('a watch needs --type and --target');
  if (interval !== null && !(Number.isFinite(Number(interval)) && Number(interval) > 0)) throw new Error('a watch --interval needs a positive number of seconds');
  if (listWatches(dir).some((w) => w.id === id)) throw new Error(`watch "${id}" already exists`);
  const watch: Watch = {
    op: 'add', id, type, target, done_when, report, notify_overnight: Boolean(notify_overnight), notify: Boolean(notify), interval: interval === null ? null : Number(interval),
    created: new Date(now).toISOString(), expires: new Date(now + ttlMs).toISOString(),
    ...(renew ? { renew: true } : {}),
  };
  append(paths(dir).watches, watch);
  return watch;
}

/** Appends a tombstone. Returns false when the id is not live (so removing twice is harmless). */
export function removeWatch(dir: string, id: string, reason = 'removed', now: number = Date.now()): boolean {
  if (!listWatches(dir).some((w) => w.id === id)) return false;
  append(paths(dir).watches, { op: 'remove', id, reason, at: new Date(now).toISOString() });
  return true;
}

/** Moves a live watch's expiry to `expiresAt` (epoch ms). Returns false when the id is not live or the time is not a finite number. */
export function renewWatch(dir: string, id: string, expiresAt: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(expiresAt) || !listWatches(dir).some((w) => w.id === id)) return false;
  append(paths(dir).watches, { op: 'renew', id, expires: new Date(expiresAt).toISOString(), at: new Date(now).toISOString() });
  return true;
}

/**
 * Marks a live watch standing (`renew: true`) without touching its expiry, for watches added before their type could renew.
 * Returns false when the id is not live or the watch is already marked.
 */
export function markStanding(dir: string, id: string, now: number = Date.now()): boolean {
  const watch = listWatches(dir).find((w) => w.id === id);
  if (!watch || watch.renew) return false;
  append(paths(dir).watches, { op: 'renew', id, expires: watch.expires, at: new Date(now).toISOString(), renew: true });
  return true;
}

const EMPTY_STATE = (): LoopState => ({ watches: {}, events: [] });

export function loadState(dir: string): LoopState {
  try {
    const raw = JSON.parse(readFileSync(paths(dir).state, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...EMPTY_STATE(), ...raw } : EMPTY_STATE();
  } catch { return EMPTY_STATE(); }
}

/** Temp file then rename, so a crash cannot leave a truncated state. */
export function saveState(dir: string, state: LoopState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${paths(dir).state}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, paths(dir).state);
}

export const appendDigest = (dir: string, events: DigestEvent[]): void => events.forEach((e) => append(paths(dir).digest, e));

/** Pending digest events. With `consume`, the file is renamed away first, so an append during the read is kept for the next one. */
export function readDigest(dir: string, { consume = false }: { consume?: boolean } = {}): DigestEvent[] {
  let file = paths(dir).digest;
  if (consume && existsSync(file)) {
    const taken = `${file}.${process.pid}.read`;
    renameSync(file, taken);
    file = taken;
  }
  const events = readLines(file).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  if (consume && existsSync(file)) rmSync(file);
  return events;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return errorCode(err) === 'EPERM'; }
};

/** The pid holding the loop lock in `dir`, or null when there is no lock or its owner is gone. Read-only: never removes the lock. */
export function lockHolder(dir: string): number | null {
  try {
    const owner = Number(readFileSync(join(dir, 'loop.lock'), 'utf8'));
    return owner > 0 && alive(owner) ? owner : null;
  } catch { return null; }
}

const LOCK_GRACE_MS = 2000;
const LOCK_ATTEMPTS = 5;

/**
 * One loop at a time: two loops over one registry would each report every event. The lock file holds the
 * owner's pid; a lock whose process is gone (or whose content is junk) is removed and taken with an exclusive
 * create, retried a few times. An empty file younger than a short grace is a lock being written, so it counts
 * as live. Released on exit, SIGINT and SIGTERM.
 */
export function acquireLock(dir: string, pid: number = process.pid): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'loop.lock');
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (attempt >= LOCK_ATTEMPTS) throw new Error('could not take the loop lock; try again');
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch (readErr) { if (errorCode(readErr) === 'ENOENT') continue; throw readErr; }
      const owner = Number(text);
      if (text.trim() === '' && Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Number.NaN) < LOCK_GRACE_MS) throw new Error('another event loop is starting');
      if (owner > 0 && alive(owner)) throw new Error(`another event loop is running (pid ${owner})`);
      // Remove only the stale lock we read; a faster process may have replaced it since.
      if (readFileSync(file, 'utf8') === text) rmSync(file, { force: true });
    }
  }
  const release = () => { try { if (readFileSync(file, 'utf8') === String(pid)) rmSync(file, { force: true }); } catch { /* already gone */ } };
  process.on('exit', release);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) process.on(sig, () => { release(); process.exit(code); });
  return file;
}

/**
 * Watch registry for the event loop: an append-only JSON lines file plus a state file.
 *
 * watches.jsonl holds two kinds of line: {op:'add', id, type, target, done_when, report, created, expires,
 * notify_overnight} and {op:'remove', id, at, reason}. The live set is the adds with no later remove, so the
 * file is never rewritten. state.json holds each watch's last checked state and the event timestamps the
 * cadence reads; digest.jsonl holds events nobody has read yet.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const paths = (dir) => ({
  watches: join(dir, 'watches.jsonl'),
  state: join(dir, 'state.json'),
  digest: join(dir, 'digest.jsonl'),
});

const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const append = (file, obj) => {
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
};

/** The live watches, oldest first. A corrupt line is skipped, never fatal. */
export function listWatches(dir) {
  const live = new Map();
  for (const line of readLines(paths(dir).watches)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.op === 'add' && rec.id) live.set(rec.id, rec);
    else if (rec?.op === 'remove') live.delete(rec.id);
  }
  return [...live.values()];
}

/** Appends a watch. `target` and `done_when` are the type's to interpret. Throws on a bad id or a duplicate live id. */
export function addWatch(dir, { id, type, target, done_when = '', report = '', ttlMs = DEFAULT_TTL_MS, notify_overnight = false }, now = Date.now()) {
  if (!ID.test(id ?? '')) throw new Error(`watch id must match ${ID}, got "${id}"`);
  if (!type || !target) throw new Error('a watch needs --type and --target');
  if (listWatches(dir).some((w) => w.id === id)) throw new Error(`watch "${id}" already exists`);
  const watch = {
    op: 'add', id, type, target, done_when, report, notify_overnight: Boolean(notify_overnight),
    created: new Date(now).toISOString(), expires: new Date(now + ttlMs).toISOString(),
  };
  append(paths(dir).watches, watch);
  return watch;
}

/** Appends a tombstone. Returns false when the id is not live (so removing twice is harmless). */
export function removeWatch(dir, id, reason = 'removed', now = Date.now()) {
  if (!listWatches(dir).some((w) => w.id === id)) return false;
  append(paths(dir).watches, { op: 'remove', id, reason, at: new Date(now).toISOString() });
  return true;
}

const EMPTY_STATE = () => ({ watches: {}, events: [] });

export function loadState(dir) {
  try {
    const raw = JSON.parse(readFileSync(paths(dir).state, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...EMPTY_STATE(), ...raw } : EMPTY_STATE();
  } catch { return EMPTY_STATE(); }
}

/** Temp file then rename, so a crash cannot leave a truncated state. */
export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${paths(dir).state}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, paths(dir).state);
}

export const appendDigest = (dir, events) => events.forEach((e) => append(paths(dir).digest, e));

/** Pending digest events. With `consume`, the file is renamed away first, so an append during the read is kept for the next one. */
export function readDigest(dir, { consume = false } = {}) {
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

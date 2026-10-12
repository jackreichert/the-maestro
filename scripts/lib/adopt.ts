/**
 * adopt.ts: the adopt record, `<event dir>/adopt.json`. It names the queue file a fresh session should read and work, so a roll or a
 * closed terminal does not lose "what to do next". It expires (default 24 hours) so tomorrow's session is not hijacked by yesterday's queue.
 * Only the path and two times are stored, never the queue's contents. A path the secret scan flags is refused at write and withheld at read.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { scanText } from './secret-scan.ts';
import { WITHHELD } from './withhold.ts';

export const ADOPT_TTL_MS = 24 * 3600 * 1000;

export interface Adopt { file: string; until: string; at: string }

export const adoptPath = (dir: string): string => join(dir, 'adopt.json');

/** Writes the record atomically. `until` is an ISO time in the future; the default is `now` plus 24 hours. Throws on a bad `until` or a secret-shaped path. */
export function writeAdopt(dir: string, file: string, { until, now = Date.now() }: { until?: string; now?: number } = {}): Adopt {
  if (!file.trim()) throw new Error('adopt needs a queue file path');
  const expires = until === undefined ? now + ADOPT_TTL_MS : Date.parse(until);
  if (!Number.isFinite(expires)) throw new Error(`--until needs an ISO time, got "${until}"`);
  if (expires <= now) throw new Error('--until is already past; the record would never be shown');
  if (scanText(file).length) throw new Error('the queue path looks like it holds a secret; adopt a path without one');
  const record: Adopt = { file: isAbsolute(file) ? file : resolve(file), until: new Date(expires).toISOString(), at: new Date(now).toISOString() };
  mkdirSync(dir, { recursive: true });
  const tmp = `${adoptPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  renameSync(tmp, adoptPath(dir));
  return record;
}

/** The live record, or null when there is none, it has expired, or it is unreadable (a broken file must never block a session start). */
export function readAdopt(dir: string, now: number = Date.now()): Adopt | null {
  try {
    const r = JSON.parse(readFileSync(adoptPath(dir), 'utf8')) as Partial<Adopt>;
    if (typeof r.file !== 'string' || typeof r.until !== 'string' || !(Date.parse(r.until) > now)) return null;
    return { file: r.file, until: r.until, at: typeof r.at === 'string' ? r.at : '' };
  } catch { return null; }
}

/** Removes the record; true when there was one. */
export function clearAdopt(dir: string): boolean {
  const had = readAdopt(dir, 0) !== null;
  rmSync(adoptPath(dir), { force: true });
  return had;
}

/** The session-start line, or '' with no live record. The path is scanned again here, since the file could have been written by hand. */
export function adoptLine(record: Adopt | null): string {
  if (!record) return '';
  const path = scanText(record.file).length ? WITHHELD : record.file;
  return `Adopted queue: ${path} (until ${record.until}). Read it and work it now.`;
}

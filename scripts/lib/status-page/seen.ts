/**
 * The status watcher's memory, beside the page: `.now-seen.md` (the page as the watcher last saw it) and
 * `.now-seen.json` (the hash of the page the generator last wrote, how many unprocessed edits it carried into it,
 * and the priorities as last rendered or reported). The generator reads both to know which edits are still unreported;
 * the watcher reads both to know which changes are the generator's own. Both files are written by temp file and rename.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PODIUM_FILE = 'NOW.md';
export const SEEN_PAGE = '.now-seen.md';
export const SEEN_META = '.now-seen.json';

export interface SeenMeta {
  /** sha256 of the page the generator last wrote. */
  generated_sha: string;
  /** Unprocessed edits the generator copied into that page; with any, the hash alone cannot prove the page has no edits. */
  carried: number;
  /** The priorities as last rendered by the generator or reported by the watcher; null when the page had none. */
  priorities_seen: string[] | null;
}

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const readOrNull = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** The current page, or null before the first run. */
export const readPodium = (dir: string): string | null => readOrNull(join(dir, PODIUM_FILE));

/** The baseline page, or null when the watcher has not seen one. */
export const readSeenPage = (dir: string): string | null => readOrNull(join(dir, SEEN_PAGE));

/** The meta file; null when absent or unreadable (an unreadable one is treated as absent, never as proof of anything). */
export function readSeenMeta(dir: string): SeenMeta | null {
  const text = readOrNull(join(dir, SEEN_META));
  if (text === null) return null;
  try {
    const m: unknown = JSON.parse(text);
    const o = m as Partial<SeenMeta>;
    const okPriorities = o.priorities_seen === null || (Array.isArray(o.priorities_seen) && o.priorities_seen.every((p) => typeof p === 'string'));
    return typeof o.generated_sha === 'string' && typeof o.carried === 'number' && okPriorities ? (o as SeenMeta) : null;
  } catch { return null; }
}

export const writeSeenPage = (dir: string, page: string): void => writeAtomic(join(dir, SEEN_PAGE), page);
export const writeSeenMeta = (dir: string, meta: SeenMeta): void => writeAtomic(join(dir, SEEN_META), `${JSON.stringify(meta)}\n`);

/**
 * The local review queue as the web server serves it: a snapshot file the producer (`local-review-snapshot.ts`) writes, and a
 * reader that only ever reads that file. Scanning every repo's branches takes seconds to minutes, so it never runs in a request
 * handler: when the file is missing or older than `staleMs`, the reader starts the producer in the background (one at a time,
 * with a hard timeout, no sooner than `retryMs` after a failure) and answers at once with what the file has plus its age.
 * The state is spelled out in `scan` and in `notes`, so "still scanning" is never shown as an empty queue.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalReview } from './local-review.ts';

export type ScanState = 'fresh' | 'scanning' | 'stale' | 'none';
export interface ScanStatus { state: ScanState; ageSeconds?: number }
export type CachedLocalReview = LocalReview & { scan: ScanStatus };

export interface LocalReviewCacheOptions {
  /** Where the snapshot lives. */
  file: string;
  /** Produce the snapshot at `file`. Resolves when written; rejects on failure. The default runs the producer script as a child process. */
  scan: (file: string) => Promise<void>;
  now?: () => Date;
  /** Older than this and a refresh starts (default 2 minutes). */
  staleMs?: number;
  /** After a failed refresh, wait this long before trying again (default 30 seconds). */
  retryMs?: number;
  log?: (message: string) => void;
}

const SCRIPT = fileURLToPath(new URL('../../local-review-snapshot.ts', import.meta.url));
const SCAN_TIMEOUT_MS = 120_000;

/** Write the snapshot atomically, so a reader never sees half a file. */
export function writeSnapshot(file: string, review: LocalReview): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(review));
  renameSync(tmp, file);
}

/** The default producer: this repo's snapshot script in its own process, killed after SCAN_TIMEOUT_MS. */
export const spawnProducer = (containerRoot: string): ((file: string) => Promise<void>) => (file) => new Promise((ok, fail) => {
  execFile(process.execPath, [SCRIPT, '--container', containerRoot, '--out', file], { timeout: SCAN_TIMEOUT_MS, killSignal: 'SIGKILL' }, (e) => (e ? fail(e) : ok()));
});

function readSnapshot(file: string): LocalReview | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as LocalReview;
    return j && typeof j.generatedAt === 'string' && typeof j.available === 'boolean' && Array.isArray(j.units) ? j : null;
  } catch { return null; }
}

const words = (s: number): string => (s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`);

export function createLocalReviewCache(o: LocalReviewCacheOptions): { read: () => CachedLocalReview } {
  const now = o.now ?? ((): Date => new Date());
  const staleMs = o.staleMs ?? 120_000;
  const retryMs = o.retryMs ?? 30_000;
  let running = false;
  let failedAt = 0;

  const refresh = (): void => {
    if (running || Date.now() - failedAt < retryMs) return;
    running = true;
    o.scan(o.file).catch((e: unknown) => { failedAt = Date.now(); o.log?.(`local review scan failed: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`); }).finally(() => { running = false; });
  };

  return {
    read(): CachedLocalReview {
      const snap = readSnapshot(o.file);
      const age = snap ? Math.max(0, Math.round((now().getTime() - Date.parse(snap.generatedAt)) / 1000)) : undefined;
      const old = age === undefined || !Number.isFinite(age) || age * 1000 > staleMs;
      if (old) refresh();
      if (!snap) {
        const reason = running ? 'The first scan of the local branches is running; the queue appears here when it finishes.' : 'The local branches have not been scanned yet, and the last scan failed; it will be retried.';
        return { generatedAt: now().toISOString(), available: false, reason, units: [], more: 0, notes: [], scan: { state: running ? 'scanning' : 'none' } };
      }
      const state: ScanState = !old ? 'fresh' : running ? 'scanning' : 'stale';
      const note = state === 'fresh' ? `Scanned ${words(age ?? 0)} ago.` : state === 'scanning' ? `A new scan is running. This list is from ${words(age ?? 0)} ago.` : `This list is from ${words(age ?? 0)} ago and the last refresh failed; it will be retried.`;
      return { ...snap, notes: [...snap.notes, note], scan: { state, ...(age === undefined ? {} : { ageSeconds: age }) } };
    },
  };
}

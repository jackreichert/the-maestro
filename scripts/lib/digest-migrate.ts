/**
 * Moves saved digests into the event inbox. Before the inbox existed the supervisor saved each exit-10 digest as a file under
 * `<ledger root>/Projects/<project>/Journal/Digests/`; a digest still unseen when the daemon starts (or one a loop of an older version saves later)
 * is parsed back into events and appended, so `events wait` and the hook see it. Each digest is claimed first (lib/digest-store.ts) and marked seen
 * only after its events are appended, and an event's id covers the digest's save time (taken from the file name), so a crash in between replays
 * the digest without adding a second copy.
 */
import { appendEvents } from './event-inbox.ts';
import { claimDigests, savedAt } from './digest-store.ts';
import type { DigestEvent } from './types.ts';

const LINE = /^(ACTION|info) (\S+) \((\S+)\): (.*?)(?: \| report: (.*))?$/;

/** The events on a digest's lines (`ACTION|info <watch> (<type>): <summary> | report: <hint>`); lines in another shape are skipped. */
export function parseDigest(text: string, at: string): DigestEvent[] {
  return text.split('\n').flatMap((line) => {
    const m = line.match(LINE);
    return m ? [{ watch: m[2], type: m[3], at, summary: m[4], actionable: m[1] === 'ACTION', report: m[5] ?? '' }] : [];
  });
}

export interface MigrateResult { digests: number; added: number; duplicates: number; refused: number }

/** Appends the events of every unseen digest in `digestDir` to the inbox in `eventDir`, then marks the digest seen. Never touches a digest another process has claimed. */
export function migrateDigests(eventDir: string, digestDir: string, now: number = Date.now()): MigrateResult {
  const total: MigrateResult = { digests: 0, added: 0, duplicates: 0, refused: 0 };
  for (const claimed of claimDigests(digestDir, now)) {
    const r = appendEvents(eventDir, parseDigest(claimed.text, savedAt(claimed.file) ?? new Date(now).toISOString()));
    claimed.finish();
    total.digests += 1;
    total.added += r.added;
    total.duplicates += r.duplicates;
    total.refused += r.refused;
  }
  return total;
}

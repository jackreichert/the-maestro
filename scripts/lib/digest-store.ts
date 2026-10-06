/**
 * Saved digests: the supervisor writes one file per actionable digest under <ledger root>/Projects/<project>/Journal/Digests/,
 * and a session reads them at start or blocks on `digest-wait`. The first line of each file is the marker
 * `<!-- seen: false -->`, flipped to `true` once something has shown the digest to a session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UNSEEN = '<!-- seen: false -->';
const SEEN = '<!-- seen: true -->';

/** Where digests live. Always under the ledger root; there is no other location to configure. */
export const digestDir = (ledgerRoot: string, project: string): string => join(ledgerRoot, 'Projects', project, 'Journal', 'Digests');

/** A UTC file stem such as 2026-10-06T14-35-00-123Z (sortable, filesystem-safe). */
const stamp = (now: number): string => new Date(now).toISOString().replace(/[:.]/g, '-');

/** Atomic write (temp file, then rename) so a waiter never reads half a digest. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Saves a digest as an unseen file and returns its path. Never overwrites: a clash gets a numeric suffix. */
export function saveDigest(dir: string, text: string, now: number = Date.now()): string {
  mkdirSync(dir, { recursive: true });
  for (let n = 0; ; n += 1) {
    const file = join(dir, `${stamp(now)}${n ? `_${String(n).padStart(3, '0')}` : ''}.md`);
    if (existsSync(file)) continue;
    writeAtomic(file, `${UNSEEN}\n${text.trimEnd()}\n`);
    return file;
  }
}

/** Unseen digest files, oldest first. */
export function unseenDigests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f))
    .filter((f) => { try { return readFileSync(f, 'utf8').startsWith(UNSEEN); } catch { return false; } });
}

/** The digest text without its marker line. */
export const digestBody = (file: string): string => readFileSync(file, 'utf8').replace(/^<!-- seen: (true|false) -->\n/, '').trimEnd();

/** Flips a digest to seen. Idempotent. */
export function markSeen(file: string): void {
  const text = readFileSync(file, 'utf8');
  if (text.startsWith(UNSEEN)) writeAtomic(file, SEEN + text.slice(UNSEEN.length));
}

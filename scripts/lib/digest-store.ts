/**
 * Saved digests: the supervisor writes one file per actionable digest under <ledger root>/Projects/<project>/Journal/Digests/,
 * and a session reads them at start or blocks on `digest-wait`. The first line of each file is the marker
 * `<!-- seen: false -->`, flipped to `true` once something has shown the digest to a session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UNSEEN = '<!-- seen: false -->';
const SEEN = '<!-- seen: true -->';

/** Where digests live. Always under the ledger root; there is no other location to configure. */
export const digestDir = (ledgerRoot: string, project: string): string => join(ledgerRoot, 'Projects', project, 'Journal', 'Digests');

/** A UTC file stem such as 2026-10-06T14-35-00-123Z (sortable, filesystem-safe). */
const stamp = (now: number): string => new Date(now).toISOString().replace(/[:.]/g, '-');

let tmpCounter = 0;

/** Atomic write: a uniquely named temp file (pid and counter, so concurrent writers never share one), then rename. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
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

const CLAIM = /^(.+\.md)\.claim-(\d+)-(\d+)$/;
const CLAIM_MAX_AGE_MS = 10 * 60 * 1000;
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A digest taken by this process: `text` is its body; `finish()` marks it seen (call after printing). */
export interface Claimed { text: string; finish: () => void }

/**
 * Claims every unseen digest, oldest first, by renaming `x.md` to `x.md.claim-<pid>-<ms>`; only the rename winner proceeds,
 * so two waiters never take the same digest. Claims whose owner is dead, or older than 10 minutes, are taken over the same way.
 * Delivery is at-least-once: a waiter killed between claiming and `finish()` leaves a claim that is later reclaimed and shown again.
 */
export function claimDigests(dir: string, now: number = Date.now(), pid: number = process.pid): Claimed[] {
  if (!existsSync(dir)) return [];
  const mine = (target: string, from: string): string | null => {
    const claim = `${target}.claim-${pid}-${now}`;
    try { renameSync(from, claim); return claim; } catch { return null; }
  };
  const unseen = new Set(unseenDigests(dir));
  const taken: { target: string; claim: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = f.match(CLAIM);
    const stale = m && (!isAlive(Number(m[2])) || now - Number(m[3]) > CLAIM_MAX_AGE_MS);
    const path = join(dir, f);
    if (m && stale) { const target = join(dir, m[1]); const c = mine(target, path); if (c) taken.push({ target, claim: c }); }
    else if (unseen.has(path)) { const c = mine(path, path); if (c) taken.push({ target: path, claim: c }); }
  }
  return taken.map(({ target, claim }) => ({
    text: readFileSync(claim, 'utf8').replace(/^<!-- seen: (true|false) -->\n/, '').trimEnd(),
    finish: () => {
      writeAtomic(target, `${SEEN}\n${readFileSync(claim, 'utf8').replace(/^<!-- seen: (true|false) -->\n/, '')}`);
      rmSync(claim, { force: true });
    },
  }));
}

/**
 * What the merge-sweep's prune decided, remembered so the Others' PRs tab's rebuild does not undo it. The rebuild reads GitHub's search, whose nodes carry
 * reviews but not inline review comments, so a PR a person only commented on line by line looked unsettled there and came straight back after a prune.
 * The prune reads the full facts (lib/drafts/settle.ts), so its verdict is the one that counts: it is stored here as `url -> updatedAt`, and the rebuild
 * keeps that PR off the tab for as long as its `updatedAt` has not moved. When it has moved, the rebuild reads the same full facts and applies the same
 * classifier (lib/teammate/settled.ts): still settled keeps it off (and the record moves to the new `updatedAt`); not settled drops the record and the card returns.
 * A PR whose facts cannot be read stays off until they can. Records for PRs no longer in the open search are forgotten.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFacts } from '../drafts/settle.ts';
import { spawnRead } from '../drafts/reconcile.ts';
import type { GhRead } from '../drafts/reconcile.ts';
import { writeAtomic } from '../status-page/seen.ts';
import { settledReason } from './settled.ts';
import type { SettledFacts } from './settled.ts';

export const PRUNED_FILE = '.now-others-pruned.json';
/** A card's identity and the version of it that was judged. */
export interface PrunedRecord { url: string; updatedAt: string }
export type FactsReader = (repo: string, number: number, self: string) => SettledFacts | null;

const isRecord = (v: unknown): v is PrunedRecord => typeof v === 'object' && v !== null && typeof (v as PrunedRecord).url === 'string' && typeof (v as PrunedRecord).updatedAt === 'string';

/** The stored verdicts, keyed by PR url; empty when there is no file or it is damaged. */
export function readPruned(dir: string): Map<string, string> {
  const path = join(dir, PRUNED_FILE);
  if (!existsSync(path)) return new Map();
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return new Map(Array.isArray(v) ? v.filter(isRecord).map((r) => [r.url, r.updatedAt] as const) : []);
  } catch { return new Map(); }
}

function writePruned(dir: string, m: ReadonlyMap<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, PRUNED_FILE), `${JSON.stringify([...m].map(([url, updatedAt]) => ({ url, updatedAt })))}\n`);
}

/** Remembers pruned cards (idempotent). Called by the prune after it has dropped them from the cache. */
export function recordPruned(dir: string, cards: readonly PrunedRecord[]): void {
  if (!cards.length) return;
  const m = readPruned(dir);
  for (const c of cards) m.set(c.url, c.updatedAt);
  writePruned(dir, m);
}

export const liveFacts = (run: GhRead = spawnRead): FactsReader => (repo, number, self) => readFacts(run, repo, number, self);

/**
 * The rebuilt list without the PRs the prune settled, per the rules above. `complete` is true when the search was read whole, which is the only time a record
 * for a PR missing from it is forgotten. Never throws on a failed write: the file is a convenience.
 */
export function applyPruned<T extends { url: string; repo: string; number: number; updatedAt: string }>(dir: string, prs: readonly T[], self: string, read: FactsReader, complete: boolean): T[] {
  const records = readPruned(dir);
  if (!records.size) return [...prs];
  const next = new Map(records);
  const out: T[] = [];
  for (const p of prs) {
    const seen = records.get(p.url);
    if (seen === undefined || seen === p.updatedAt) { if (seen === undefined) out.push(p); continue; }
    const facts = read(p.repo, p.number, self);
    if (!facts) continue;
    if (settledReason(facts)) next.set(p.url, p.updatedAt);
    else { next.delete(p.url); out.push(p); }
  }
  if (complete) { const here = new Set(prs.map((p) => p.url)); for (const u of [...next.keys()]) if (!here.has(u)) next.delete(u); }
  try { if (next.size !== records.size || [...next].some(([u, t]) => records.get(u) !== t)) writePruned(dir, next); } catch { /* a convenience */ }
  return out;
}

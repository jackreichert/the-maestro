/**
 * The PR cache, `<statusDir>/.now-prs.json`: the last open-PR set GitHub returned and when it was fetched.
 * The generator writes it after every good read and falls back to it when a read fails, so the page keeps updating
 * (and says plainly how old its PR data is) instead of going stale. Written by temp file and rename.
 * A cache that is not shaped like the GitHub search result is treated as absent: a hand-damaged file must not crash the page.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawPr } from './generate.ts';
import { writeAtomic } from './seen.ts';

export const PRS_CACHE = '.now-prs.json';

export interface PrCache { fetchedAt: Date; prs: RawPr[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** True when `v` has every field the generator reads from a search result. */
function isRawPr(v: unknown): v is RawPr {
  if (!isObject(v)) return false;
  const repo = v.repository;
  const threads = v.reviewThreads;
  const commits = v.commits;
  return typeof v.number === 'number' && typeof v.title === 'string' && typeof v.url === 'string' && typeof v.headRefName === 'string'
    && isObject(repo) && typeof repo.nameWithOwner === 'string'
    && isObject(threads) && Array.isArray(threads.nodes) && isObject(commits) && Array.isArray(commits.nodes);
}

/** The cached PRs and fetch time; null when there is no cache or it is unreadable. */
export function readPrCache(dir: string): PrCache | null {
  const path = join(dir, PRS_CACHE);
  if (!existsSync(path)) return null;
  try {
    const c: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(c) || typeof c.fetched_at !== 'string' || !Array.isArray(c.prs)) return null;
    const fetchedAt = new Date(c.fetched_at);
    return Number.isFinite(fetchedAt.getTime()) && c.prs.every(isRawPr) ? { fetchedAt, prs: c.prs } : null;
  } catch { return null; }
}

export function writePrCache(dir: string, cache: PrCache): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, PRS_CACHE), `${JSON.stringify({ fetched_at: cache.fetchedAt.toISOString(), prs: cache.prs })}\n`);
}

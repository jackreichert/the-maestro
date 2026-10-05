/**
 * Regenerates the status page: reads the board, the open PRs and the files beside the page, renders it, writes it.
 * Every outside read comes in through `deps`, so tests run it with no ledger, no gh and no clock.
 * Writes `<statusDir>/NOW.md` (and `<statusDir>/YYYY-MM-DD.md` with `snapshot`) and the watcher's `.now-seen.json`, each through a temp file and a rename.
 * Edits the user typed into the page that the status watcher has not reported yet are copied into the new page (see inline.ts).
 * Only one rebuild runs at a time (lock.ts). Exit paths that fail before the write leave the old page as it was: a partial page is never written.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPage } from './render.ts';
import type { BoardStatus, PageConfig, Pr, PrData, Triage } from './render.ts';
import { prStream } from './streams.ts';
import type { StreamEvidence } from './streams.ts';
import { carryInline, countUnprocessed, extractFields, unprocessed } from './inline.ts';
import type { Unprocessed } from './inline.ts';
import { localDate, readPriorities } from './priorities.ts';
import { readPrCache, writePrCache } from './prcache.ts';
import { acquireLock, processAlive } from './lock.ts';
import { NOW_FILE, readNow, readSeenMeta, readSeenPage, sha, writeAtomic, writeSeenMeta } from './seen.ts';

/** A pull request as the GraphQL search returns it. */
export interface RawPr {
  number: number; title: string; url: string; isDraft: boolean; baseRefName: string; headRefName: string;
  mergeable: string; mergeStateStatus: string; reviewDecision: string | null;
  repository: { nameWithOwner: string };
  reviewThreads: { nodes: { isResolved: boolean }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export interface GenerateDeps {
  /** `journal.ts <sub> --json`, parsed. Throws when the ledger cannot be read. */
  journal(sub: 'status' | 'triage'): unknown;
  /** Open PRs; throws when GitHub cannot be read. */
  fetchPrs(): RawPr[];
  sleep(ms: number): void;
  now(): Date;
  /** Whether a process exists, for stale-lock recovery (default: ask the OS). */
  pidAlive?(pid: number): boolean;
  /** Called after the page on disk is read and before it is rewritten: the window in which a user's save can land. Tests use it to land one. */
  beforeWrite?(): void;
}

/** `cachedPrsOnly` renders the last cached PR set without a GitHub read (quiet hours, or PR data still fresh). */
export interface GenerateOptions { statusDir: string; dryRun: boolean; snapshot: boolean; command: string; config: PageConfig; cachedPrsOnly?: boolean }
/** `prFailure` is why the GitHub read failed when the page was built from the cache (or without PRs); absent when it succeeded. */
export interface GenerateResult { page: string; written: string[]; prFailure?: string }

/** A JSON file beside the page; absent is `{}`, malformed throws (a silent fallback would hide a typo as an empty map). */
export function readJson<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { throw new Error(`${path} is not valid JSON`); }
}

/** Open PRs with their stream (see streams.ts for the order the evidence is weighed in). */
export function loadPrs(raw: RawPr[], evidence: StreamEvidence): Pr[] {
  return raw.map((n): Pr => {
    const [owner = '', short = ''] = n.repository.nameWithOwner.split('/');
    const stream = prStream({ number: n.number, title: n.title, headRefName: n.headRefName, short, nameWithOwner: n.repository.nameWithOwner }, evidence);
    return {
      number: n.number, title: n.title, url: n.url, isDraft: n.isDraft, baseRefName: n.baseRefName, headRefName: n.headRefName,
      mergeable: n.mergeable, mergeStateStatus: n.mergeStateStatus, reviewDecision: n.reviewDecision,
      repo: n.repository.nameWithOwner, short, owner,
      unresolved: n.reviewThreads.nodes.filter((t) => !t.isResolved).length,
      ci: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE', stream,
    };
  });
}

/** GitHub computes `mergeable` lazily: one more read, a few seconds later, settles the UNKNOWN ones. */
function settle(deps: GenerateDeps): RawPr[] {
  const first = deps.fetchPrs();
  if (!first.some((n) => n.mergeable === 'UNKNOWN')) return first;
  deps.sleep(5000);
  const again = new Map(deps.fetchPrs().map((n) => [n.url, n]));
  return first.map((n) => (n.mergeable === 'UNKNOWN' ? again.get(n.url) ?? n : n));
}

/** The first line of a caught value's message. */
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

/**
 * Open PRs from GitHub, remembered in the cache. When the read fails, the last cached set with its fetch time (or none)
 * and the reason; the caller still writes the page. A dry run reads the cache but never writes it.
 */
function readPrs(statusDir: string, deps: GenerateDeps, dryRun: boolean, cachedOnly: boolean): { raw: RawPr[]; data: PrData } {
  if (cachedOnly) {
    const cached = readPrCache(statusDir);
    return { raw: cached?.prs ?? [], data: { fetchedAt: cached?.fetchedAt ?? null } };
  }
  try {
    const raw = settle(deps);
    const fetchedAt = deps.now();
    if (!dryRun) writePrCache(statusDir, { fetchedAt, prs: raw });
    return { raw, data: { fetchedAt } };
  } catch (e) {
    const cached = readPrCache(statusDir);
    return { raw: cached?.prs ?? [], data: { fetchedAt: cached?.fetchedAt ?? null, failure: firstLine(e) || 'unknown error' } };
  }
}

/** Edits in the page on disk that the status watcher has not reported yet, and the priorities it last knew (null if none). */
function pendingEdits(statusDir: string, current: string | null): { edits: Unprocessed; seenPriorities: string[] | null } {
  const baselineText = readSeenPage(statusDir);
  const baseline = baselineText === null ? null : extractFields(baselineText);
  const meta = readSeenMeta(statusDir);
  const seenPriorities = meta ? meta.priorities_seen : baseline?.priorities ?? null;
  if (current === null) return { edits: { answers: {}, ticks: [], priorities: null }, seenPriorities };
  return { edits: unprocessed(extractFields(current), baseline, meta ? meta.priorities_seen : undefined), seenPriorities };
}

/** Builds the page and, unless `dryRun`, writes it, holding `.now.lock` so two rebuilds never run at once. Throws before writing anything if a read fails. */
export function generate(opts: GenerateOptions, deps: GenerateDeps): GenerateResult {
  if (opts.dryRun) return build(opts, deps);
  const release = acquireLock(opts.statusDir, { nowMs: () => deps.now().getTime(), sleep: deps.sleep, pidAlive: deps.pidAlive ?? processAlive, pid: process.pid });
  try { return build(opts, deps); } finally { release(); }
}

function build(opts: GenerateOptions, deps: GenerateDeps): GenerateResult {
  const { statusDir, config } = opts;
  const overrides = readJson<Record<string, string>>(join(statusDir, 'stream-overrides.json'));
  const ticketMap = readJson<Record<string, string[]>>(join(statusDir, 'ticket-map.json'));
  const status = deps.journal('status') as BoardStatus;
  const triage = deps.journal('triage') as Triage;
  const items = [...status.inflight, ...status.blocked, ...status.awaiting, ...status.done];
  const { raw, data: prData } = readPrs(statusDir, deps, opts.dryRun, !!opts.cachedPrsOnly);
  const prs = loadPrs(raw, { items, ticketMap, overrides, repoStreams: config.repoStreams, keyPattern: config.trackerKeyPattern });
  const now = deps.now();
  const priorities = readPriorities(statusDir, localDate(now, config.tz));
  const rendered = renderPage({ now, status, triage, prs, prData, ticketMap, priorities, config, command: opts.command });
  // The page on disk may hold an answer the watcher has not reported. Carry it forward, and if the user saves another
  // edit while this runs, start over from what they saved: the write below only happens against the page we read.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = readNow(statusDir);
    const { edits, seenPriorities } = pendingEdits(statusDir, current);
    const page = current === null ? rendered.page : carryInline(rendered.page, edits, current);
    if (opts.dryRun) return { page, written: [], prFailure: prData.failure };
    mkdirSync(statusDir, { recursive: true });
    deps.beforeWrite?.();
    if (readNow(statusDir) !== current) continue;
    const written = [join(statusDir, NOW_FILE)];
    writeAtomic(written[0] as string, page);
    const kept = edits.priorities ? seenPriorities : extractFields(page).priorities;
    writeSeenMeta(statusDir, { generated_sha: sha(page), carried: countUnprocessed(edits), priorities_seen: kept });
    if (opts.snapshot) { written.push(join(statusDir, `${rendered.date}.md`)); writeAtomic(written[1] as string, page); }
    return { page, written, prFailure: prData.failure };
  }
  throw new Error(`${join(statusDir, NOW_FILE)} kept changing while it was being regenerated; run again`);
}

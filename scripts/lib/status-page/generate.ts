/**
 * Regenerates the status page: reads the board, the open PRs and the files beside the page, renders it, writes it.
 * Every outside read comes in through `deps`, so tests run it with no ledger, no gh and no clock.
 * Writes only `<statusDir>/NOW.md` (and `<statusDir>/YYYY-MM-DD.md` with `snapshot`), through a temp file and a rename.
 * Exit paths that fail before the write leave the old page as it was: a partial page is never written.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPage } from './render.ts';
import type { BoardStatus, PageConfig, Pr, Triage } from './render.ts';
import { localDate, readPriorities } from './priorities.ts';

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
}

export interface GenerateOptions { statusDir: string; dryRun: boolean; snapshot: boolean; command: string; config: PageConfig }
export interface GenerateResult { page: string; written: string[] }

/** A JSON file beside the page; absent is `{}`, malformed throws (a silent fallback would hide a typo as an empty map). */
export function readJson<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { throw new Error(`${path} is not valid JSON`); }
}

/** Open PRs with their stream: an override `repo#N` (or `owner/repo#N`), else the repo's stream, else `other`. */
export function loadPrs(raw: RawPr[], overrides: Record<string, string>, repoStreams: Record<string, string>): Pr[] {
  return raw.map((n): Pr => {
    const [owner = '', short = ''] = n.repository.nameWithOwner.split('/');
    const stream = overrides[`${short}#${n.number}`] ?? overrides[`${n.repository.nameWithOwner}#${n.number}`] ?? repoStreams[short] ?? 'other';
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

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

/** Builds the page and, unless `dryRun`, writes it. Throws before writing anything if a read fails. */
export function generate(opts: GenerateOptions, deps: GenerateDeps): GenerateResult {
  const { statusDir, config } = opts;
  const overrides = readJson<Record<string, string>>(join(statusDir, 'stream-overrides.json'));
  const ticketMap = readJson<Record<string, string[]>>(join(statusDir, 'ticket-map.json'));
  const status = deps.journal('status') as BoardStatus;
  const triage = deps.journal('triage') as Triage;
  const prs = loadPrs(settle(deps), overrides, config.repoStreams);
  const now = deps.now();
  const priorities = readPriorities(statusDir, localDate(now, config.tz));
  const { page, date } = renderPage({ now, status, triage, prs, ticketMap, priorities, config, command: opts.command });
  if (opts.dryRun) return { page, written: [] };
  mkdirSync(statusDir, { recursive: true });
  const written = [join(statusDir, 'NOW.md')];
  writeAtomic(written[0] as string, page);
  if (opts.snapshot) { written.push(join(statusDir, `${date}.md`)); writeAtomic(written[1] as string, page); }
  return { page, written };
}

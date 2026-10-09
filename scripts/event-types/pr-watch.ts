/**
 * pr-watch: review activity on the user's open PRs (scoped by local-config: gh_org, gh_login). Target `open-prs`, or
 * `open-prs:baseline` to record the first snapshot silently (nothing is reported for what is already there).
 * The state is the snapshot itself: { board, reported, left, silent? }, kept in the loop's own state file, so the loop
 * saves it together with its digest and a crash cannot separate the two (there is no per-watch file to fall out of step).
 *
 * An event is wake-worthy when, against the previous snapshot, there is:
 *   - a new unresolved review thread, from anyone but the user (bots included): THREAD;
 *   - a new reply in an open thread, from anyone but the user: REPLY;
 *   - a new top-level PR comment or review body from anyone but the user: COMMENT, REVIEW;
 *   - a reviewDecision flip into or out of APPROVED / CHANGES_REQUESTED: DECISION;
 *   - an open PR that turned CONFLICTING with its base: CONFLICT (once per conflict; GitHub's UNKNOWN, while it computes
 *     mergeability, changes nothing, and a conflict that clears resets silently so the next one speaks);
 *   - the next concrete fix, when it changes: one steering event naming conflict with base, a failing check, or an open
 *     review thread, including the PR number. A CONFLICT or THREAD line already emitted for that change is not repeated;
 *   - a PR that left the open set, once GitHub confirms it is no longer open: LEFT-OPEN-SET.
 * Standing conditions (APPROVED-UNMERGED) speak once, when they first appear or their signature (the head) changes.
 *
 * A check also requests a Copilot review on any draft PR, in a copilot_orgs owner, that Copilot has neither reviewed nor
 * been asked to review. A failed fetch, or a search that lost more than half the open set, throws: the loop keeps the
 * last good snapshot and the next tick compares against it. Cadence and quiet hours are the loop's (lib/cadence.ts).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COPILOT_ORGS, GH_LOGIN, PR_SEARCH, SELF_REVIEW_REPOS } from '../local-config.ts';
import { isSelfReview } from '../lib/self-review.ts';
import { searchAllPages } from '../lib/gh-search.ts';
import { markPrsDirty } from '../lib/status-page/dirty.ts';
import type { CheckContext, Watch, WatchEvent } from '../lib/types.ts';

/** pr-watch never reads the clock, so a check needs everything the loop passes except `now`. */
type Ctx = Omit<CheckContext, 'now'>;

/** A reference to something a person wrote: its id, who wrote it and where to read it. */
interface Ref { id: string; who: string; url: string }

/** One open PR reduced to what a diff needs. */
export interface BoardPr {
  url: string;
  repo: string;
  number: number;
  isDraft: boolean;
  head: string;
  /** Branch names, so a line says what to merge into what. */
  headRef: string;
  base: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN: GitHub's last settled answer, carried across ticks while it re-computes. Absent in older snapshots. */
  mergeable?: string;
  needsCopilot: boolean;
  /** The repo is in self_review_repos: only the user reviews it, so its lines are labelled apart from the org's. Absent in older snapshots. */
  selfReview?: boolean;
  decision: string;
  /** Failing check names, when known. The search query does not select check rolls, so fetchBoard leaves this unset. */
  failingChecks?: string[];
  threads: Ref[];
  replies: Ref[];
  comments: Ref[];
  reviews: (Ref & { state: string })[];
}

/** Every open PR keyed `owner/repo#n`. */
export type Board = Record<string, BoardPr>;

/** The part of the state a diff compares: the board, and the standing conditions already told (condition id -> signature). */
export interface Snapshot { board: Board; reported: Record<string, string> }

export interface PrWatchState extends Snapshot {
  /** Lines for PRs that left the open set since the previous snapshot. */
  left: string[];
  /** A baseline first check: report nothing. */
  silent: boolean;
  /** Steering summary when the next concrete fix changed. Absent when there is nothing new to fix. */
  steering?: string;
  /** The snapshot adopted from an older pr-review file, when this check compared against it. */
  carried?: Snapshot;
}

/** The fields of the GraphQL search node that QUERY selects. */
interface Login { login?: string }
interface PrNode {
  number: number;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable?: string | null;
  headRefName?: string;
  baseRefName?: string;
  headRefOid: string;
  repository: { nameWithOwner: string };
  reviewRequests: { nodes: { requestedReviewer?: Login | null }[] };
  latestReviews: { nodes: { author?: Login | null }[] };
  reviewThreads: { nodes: { id: string; isResolved: boolean; comments: { nodes: { author?: Login | null; url: string }[] }; last: { nodes: { id: string; author?: Login | null; url: string }[] } }[] };
  comments: { nodes: { id: string; author?: Login | null; url: string }[] };
  reviews: { nodes: { id: string; author?: Login | null; state: string; body?: string | null; url: string }[] };
}

// Scheduling: default seconds between checks (the old watcher's steady pace; idle back-off stretches it), and whether a check calls the network.
export const interval = 600;
export const renews = true;
export const network = true;
// Polling PRs faster than every 5 minutes cost more wake-ups than it saved (2026-09-27), so this type's floor is above the network one.
export const floor = 300;
// In quiet hours with watch_quiet_hours_mode: slow this watch keeps polling, at 1800s; otherwise the loop skips it.
export const slowInQuiet = true;
// One watch covers every open PR; a second would only duplicate its events (and pr-review resolves to this same type).
export const singleton = true;
// The old watcher ran until stopped, so a watch lives 72h, not the loop's 24h.
export const defaultTtlMs = (): number => 72 * 3600 * 1000;

const COPILOT = 'copilot-pull-request-reviewer';
const TARGETS = new Set(['open-prs', 'open-prs:baseline']);

const QUERY = `query($after: String) { search(query: "${PR_SEARCH}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number url isDraft reviewDecision mergeable headRefName baseRefName headRefOid repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on Bot { login } } } }
  latestReviews(first: 20) { nodes { author { login } } }
  reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { author { login } url } } last: comments(last: 1) { nodes { id author { login } url } } } }
  comments(last: 20) { nodes { id author { login } url } }
  reviews(last: 20) { nodes { id author { login } state body url } }
} } } }`;

/** Throws unless the target is `open-prs` or `open-prs:baseline` (the loop calls this at `add`). */
export function validate(target: string): void {
  if (!TARGETS.has(target)) throw new Error(`pr-watch target must be "open-prs" or "open-prs:baseline", got "${target}"`);
}

const firstLine = (text: unknown): string => String(text || '').split('\n')[0];

function gh(ctx: Ctx, args: string[], what: string): string {
  const r = ctx.run('gh', args);
  if (r.status !== 0) throw new Error(`${what} failed: ${firstLine(r.stderr)}`);
  return r.stdout;
}

/** The user's login: gh_login when set, else asked of gh. */
const selfLogin = (ctx: Ctx): string => ctx.config?.ghLogin ?? (GH_LOGIN || gh(ctx, ['api', 'user', '--jq', '.login'], 'gh api user').trim());

/** GitHub answers UNKNOWN (or nothing) while it computes mergeability: that is no news, so the last settled answer stands. */
function settledMergeable(now: string | null | undefined, old: BoardPr | undefined): string {
  return now === 'MERGEABLE' || now === 'CONFLICTING' ? now : old?.mergeable ?? 'UNKNOWN';
}

/** The label a self-review PR's event lines start with, so a digest keeps them apart from the org's. */
const label = (pr: Pick<BoardPr, 'selfReview'>): string => (pr.selfReview ? '[self-review] ' : '');

/** Every open PR as a plain board keyed `owner/repo#n`, reduced to what a diff needs. */
function fetchBoard(ctx: Ctx, self: string, before: Board = {}): Board {
  const owners = new Set((ctx.config?.copilotOrgs ?? COPILOT_ORGS).map((o) => o.toLowerCase()));
  // Fail closed: Copilot is requested only where the repo owner is listed in copilot_orgs (GitHub logins are case-insensitive).
  const copilotAllowed = (nameWithOwner: string) => owners.has((nameWithOwner.split('/')[0] ?? '').toLowerCase());
  const selfRepos = ctx.config?.selfReviewRepos ?? SELF_REVIEW_REPOS;
  const board: Board = {};
  // Paginated: the search returns 50 PRs a page, and PRs past the first page must not look closed.
  for (const pr of searchAllPages<PrNode>(QUERY, ctx.run)) {
    const copilotSeen =
      pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === COPILOT) ||
      pr.latestReviews.nodes.some((r) => r.author?.login === COPILOT);
    const key = `${pr.repository.nameWithOwner}#${pr.number}`;
    board[key] = {
      url: pr.url,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      isDraft: pr.isDraft,
      head: pr.headRefOid,
      headRef: pr.headRefName || '',
      base: pr.baseRefName || '',
      mergeable: settledMergeable(pr.mergeable, before[key]),
      selfReview: isSelfReview(pr.repository.nameWithOwner, selfRepos),
      needsCopilot: pr.isDraft && !copilotSeen && copilotAllowed(pr.repository.nameWithOwner),
      decision: pr.reviewDecision || 'NONE',
      threads: pr.reviewThreads.nodes.flatMap((t) => {
        const first = t.comments.nodes[0];
        const who = first?.author?.login;
        return !t.isResolved && first && who && who !== self ? [{ id: t.id, who, url: first.url }] : [];
      }),
      // The newest comment on each open thread, so a reply in an existing thread wakes us too, not just new threads.
      replies: pr.reviewThreads.nodes.flatMap((t) => {
        const last = t.last.nodes[0];
        const who = last?.author?.login;
        return !t.isResolved && last && who && who !== self ? [{ id: last.id, who, url: last.url }] : [];
      }),
      comments: pr.comments.nodes.flatMap((c) => {
        const who = c.author?.login;
        return who && who !== self ? [{ id: c.id, who, url: c.url }] : [];
      }),
      reviews: pr.reviews.nodes.flatMap((r) => {
        const who = r.author?.login;
        // Copilot's review body is a summary; its actionable findings arrive as threads.
        return who && who !== self && who !== COPILOT && (r.body?.trim() || r.state !== 'COMMENTED') ? [{ id: r.id, who, state: r.state, url: r.url }] : [];
      }),
    };
  }
  return board;
}

// More than half the open set vanishing in one tick is a bad fetch, not a merge spree.
function looksTruncated(prev: Board, next: Board): boolean {
  const before = Object.keys(prev).length;
  return before >= 4 && Object.keys(next).length < before / 2;
}

// A PR missing from one search result is only reported once GitHub confirms it is no longer open;
// a lagging search index must not look like a merge.
function confirmedClosed(pr: BoardPr, ctx: Ctx): boolean {
  const r = ctx.run('gh', ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'state', '-q', '.state']);
  return r.status === 0 && r.stdout.trim() !== 'OPEN';
}

// Standing conditions stay true tick after tick (an approved PR the user is deliberately holding back). Each has a stable
// id and a signature; it wakes only when its signature is new or changed, e.g. a fresh approval on a moved head.
const STANDING: { kind: string; applies: (pr: BoardPr) => boolean; signature: (pr: BoardPr) => string }[] = [
  { kind: 'APPROVED-UNMERGED', applies: (pr) => pr.decision === 'APPROVED', signature: (pr) => pr.head || 'unknown-head' },
];

const standingConditions = (board: Board): { id: string; sig: string; line: string }[] => STANDING.flatMap(({ kind, applies, signature }) =>
  Object.entries(board).filter(([, pr]) => applies(pr)).map(([key, pr]) => ({ id: `${kind} ${key}`, sig: signature(pr), line: `${label(pr)}${kind} ${key} ${pr.url}` })));

/** Everything told so far, pruned to the conditions that still hold: a cleared condition wakes again if it returns. */
const reportedNow = (board: Board): Record<string, string> => Object.fromEntries(standingConditions(board).map((c) => [c.id, c.sig]));

// The user wants Copilot's pass resolved before they review a draft. It runs once per PR: after the request (or its review) needsCopilot is false.
function requestCopilot(board: Board, ctx: Ctx): void {
  for (const [key, pr] of Object.entries(board)) {
    if (!pr.needsCopilot) continue;
    const r = ctx.run('gh', ['pr', 'edit', String(pr.number), '--repo', pr.repo, '--add-reviewer', '@copilot']);
    if (r.status === 0) pr.needsCopilot = false;
    else console.error(`copilot request failed for ${key}: ${firstLine(r.stderr)}`);
  }
}

/** The snapshot before this install moved into the loop: pr-review kept { board, reported } in its own file, which we adopt once. */
function legacySnapshot(ctx: Ctx): Snapshot | null {
  const file = ctx.dir && ctx.watch ? join(ctx.dir, `pr-review-${ctx.watch.id}.json`) : '';
  if (!file || !existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return 'board' in raw ? { board: (raw as Partial<Snapshot>).board || {}, reported: (raw as Partial<Snapshot>).reported || {} } : { board: raw as Board, reported: {} };
  } catch { return null; }
}

/** The previous snapshot, or null: a state from the old wrapper (no board) falls back to its state file, else counts as a first check. */
// Only a watch that already has some state can have an older file to adopt; a fresh watch never replays a stale one.
export const hasBoard = (state: unknown): state is Snapshot => typeof state === 'object' && state !== null && Boolean((state as Partial<Snapshot>).board);

const previous = (ctx: Ctx): Snapshot | null => {
  if (hasBoard(ctx.prev)) return ctx.prev;
  return ctx.prev ? legacySnapshot(ctx) : null;
};

export function check(target: string, ctx: Ctx): PrWatchState {
  const prev = previous(ctx);
  const board = fetchBoard(ctx, selfLogin(ctx), prev?.board);
  if (prev && looksTruncated(prev.board, board)) {
    throw new Error(`search returned ${Object.keys(board).length} of ${Object.keys(prev.board).length} PRs; skipping tick`);
  }
  // Idempotent: GitHub ignores a repeat add-reviewer and the next fetch sees the request, so a failed save only repeats a no-op.
  requestCopilot(board, ctx);
  const left = prev ? Object.entries(prev.board).filter(([key, pr]) => !board[key] && confirmedClosed(pr, ctx)).map(([key, pr]) => `${label(pr)}LEFT-OPEN-SET ${key} (merged or closed) ${pr.url}`) : [];
  // `reported` is what this snapshot's standing conditions look like once told (so the next diff stays quiet about them).
  // A silent (baseline) first check reports nothing at all; a normal first check has told nobody yet, so diff() speaks.
  // `carried` hands diff() the old file's snapshot when that is what this check compared against.
  const silent = !prev && target === 'open-prs:baseline';
  const steering = silent ? undefined : steeringEvent(comparedBoard(prev?.board, board), board)[0]?.summary;
  const state: PrWatchState = { board, reported: reportedNow(board), left, silent, ...(steering ? { steering } : {}) };
  return prev && !hasBoard(ctx.prev) ? { ...state, carried: prev } : state;
}

/** The board a diff compares against. A first check has no previous mergeability, so a conflict already there can speak once. */
function comparedBoard(prevBoard: Board | undefined, next: Board): Board {
  return prevBoard ?? Object.fromEntries(Object.entries(next).map(([key, pr]) => [key, { ...pr, mergeable: undefined }]));
}

interface NextFix { kind: 'conflict' | 'failing-check' | 'thread'; number: number; label: string; phrase: string; sig: string; rank: number; key: string }

/** The next concrete fix: a conflict blocks the merge, then a failing check, then an open thread. Stable by PR key. */
function nextFix(board: Board): NextFix | null {
  const found: NextFix[] = [];
  for (const [key, pr] of Object.entries(board)) {
    const tag = label(pr);
    if (pr.mergeable === 'CONFLICTING') found.push({ kind: 'conflict', number: pr.number, label: tag, phrase: 'conflict with base', sig: `conflict:${key}`, rank: 0, key });
    const failed = [...(pr.failingChecks ?? [])].map((name) => name.trim()).filter(Boolean).sort();
    if (failed[0]) found.push({ kind: 'failing-check', number: pr.number, label: tag, phrase: `failing check ${failed[0]}`, sig: `check:${key}:${failed.join(',')}`, rank: 1, key });
    const open = pr.threads?.[0];
    if (open) found.push({ kind: 'thread', number: pr.number, label: tag, phrase: `open review thread ${open.url || open.id}`, sig: `thread:${key}:${open.id}`, rank: 2, key });
  }
  found.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  return found[0] ?? null;
}

/**
 * One steering event when the next concrete fix changed. An empty board, or one whose next fix is unchanged, yields none.
 * The summary names which of the three it is and the PR number. It is not a CONFLICT or THREAD line.
 */
export function steeringEvent(before: Board, next: Board): WatchEvent[] {
  const fix = nextFix(next);
  if (!fix || nextFix(before)?.sig === fix.sig) return [];
  return [{ summary: `${fix.label}STEER pr ${fix.number} ${fix.phrase}` }];
}

/** True when `line` names this PR number after a hash, and not a longer number. */
function mentionsPr(line: string, n: string): boolean {
  const at = line.indexOf(`#${n}`);
  if (at < 0) return false;
  const after = line[at + n.length + 1];
  return after === undefined || after < '0' || after > '9';
}

/** True when this diff already has the fact line for that fix, so a second queue line would only restate it. */
function steerAlreadyLined(lines: string[], summary: string): boolean {
  const n = summary.match(/STEER pr (\d+) /)?.[1];
  if (!n) return false;
  if (summary.includes('conflict with base')) return lines.some((line) => line.includes('CONFLICT ') && mentionsPr(line, n));
  if (summary.includes('open review thread')) return lines.some((line) => line.includes('THREAD ') && mentionsPr(line, n));
  return false;
}

/** The lines for what changed between two boards, newest state last. */
function changesBetween(prev: Board, next: Board): string[] {
  const lines: string[] = [];
  for (const [key, pr] of Object.entries(next)) {
    const old = prev[key];
    const seen = (list: 'threads' | 'replies' | 'comments' | 'reviews', id: string): boolean => (old ? (old[list] || []).some((x) => x.id === id) : false);
    // NONE <-> REVIEW_REQUIRED flips whenever threads resolve or commits land; only a move into or out of APPROVED / CHANGES_REQUESTED is worth waking for.
    const quiet = new Set(['NONE', 'REVIEW_REQUIRED']);
    // CONFLICT speaks on the way in (a PR we never saw before, or one last settled as anything but CONFLICTING); staying conflicted is silent.
    if (pr.mergeable === 'CONFLICTING' && old?.mergeable !== 'CONFLICTING') lines.push(`${label(pr)}CONFLICT ${key} ${pr.base || '?'} <- ${pr.headRef || '?'} ${pr.url}`);
    if (old && old.decision !== pr.decision && !(quiet.has(old.decision) && quiet.has(pr.decision))) lines.push(`${label(pr)}DECISION ${key}: ${old.decision} -> ${pr.decision} ${pr.url}`);
    for (const t of pr.threads) if (!seen('threads', t.id)) lines.push(`${label(pr)}THREAD ${key} by ${t.who}: ${t.url}`);
    const newThreadUrls = new Set(pr.threads.filter((t) => !seen('threads', t.id)).map((t) => t.url));
    for (const r of pr.replies || []) if (!seen('replies', r.id) && !newThreadUrls.has(r.url)) lines.push(`${label(pr)}REPLY ${key} by ${r.who}: ${r.url}`);
    for (const c of pr.comments) if (!seen('comments', c.id)) lines.push(`${label(pr)}COMMENT ${key} by ${c.who}: ${c.url}`);
    for (const r of pr.reviews) if (!seen('reviews', r.id)) lines.push(`${label(pr)}REVIEW ${key} by ${r.who} (${r.state}): ${r.url}`);
  }
  return lines;
}

/**
 * Any event also touches the status page's PR-dirty marker (lib/status-page/dirty.ts), so the page's PR tables refresh.
 * diff(null, next) is the first check: nothing "changed", but standing conditions not yet told about are worth waking for
 * (none at all after a baseline). A prev without a board is the pre-loop shape: next.carried then holds the snapshot adopted from its file.
 */
export function diff(prev: unknown, next: PrWatchState): WatchEvent[] {
  const events = changes(prev, next);
  if (events.length) markPrsDirty();
  return events;
}

function changes(prev: unknown, next: PrWatchState): WatchEvent[] {
  const base: Partial<Snapshot> | undefined = hasBoard(prev) ? prev : next.carried;
  if (next.silent && !base) return [];
  // A first check has nothing to compare, but a conflict already there is news nobody has been told: compare as if it were new.
  const before = comparedBoard(base?.board, next.board);
  const told = base?.reported ?? {};
  const fresh = standingConditions(next.board).filter((c) => told[c.id] !== c.sig).map((c) => c.line);
  const lines = [...changesBetween(before, next.board), ...(next.left ?? []), ...fresh];
  for (const event of steeringEvent(before, next.board)) {
    if (!steerAlreadyLined(lines, event.summary)) lines.push(event.summary);
  }
  return lines.map((summary) => ({ summary }));
}

/** The loop calls this when the watch retires or is removed: drop the state file an older pr-review kept. */
export function retired(watch: Pick<Watch, 'id'>, ctx: Pick<CheckContext, 'dir'>): void {
  if (ctx.dir) rmSync(join(ctx.dir, `pr-review-${watch.id}.json`), { force: true });
}

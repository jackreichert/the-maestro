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
 *   - a PR that left the open set, once GitHub confirms it is no longer open: LEFT-OPEN-SET.
 * Standing conditions (APPROVED-UNMERGED) speak once, when they first appear or their signature (the head) changes.
 *
 * A check also requests a Copilot review on any draft PR, in a copilot_orgs owner, that Copilot has neither reviewed nor
 * been asked to review. A failed fetch, or a search that lost more than half the open set, throws: the loop keeps the
 * last good snapshot and the next tick compares against it. Cadence and quiet hours are the loop's (lib/cadence.mjs).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COPILOT_ORGS, GH_LOGIN, PR_SEARCH } from '../local-config.mjs';
import { searchAllPages } from '../lib/gh-search.mjs';

// Scheduling: default seconds between checks (the old watcher's steady pace; idle back-off stretches it), and whether a check calls the network.
export const interval = 600;
export const network = true;
// Polling PRs faster than every 5 minutes cost more wake-ups than it saved (2026-09-27), so this type's floor is above the network one.
export const floor = 300;

const COPILOT = 'copilot-pull-request-reviewer';
const TARGETS = new Set(['open-prs', 'open-prs:baseline']);

const QUERY = `query($after: String) { search(query: "${PR_SEARCH}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number url isDraft reviewDecision headRefOid repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on Bot { login } } } }
  latestReviews(first: 20) { nodes { author { login } } }
  reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { author { login } url } } last: comments(last: 1) { nodes { id author { login } url } } } }
  comments(last: 20) { nodes { id author { login } url } }
  reviews(last: 20) { nodes { id author { login } state body url } }
} } } }`;

/** Throws unless the target is `open-prs` or `open-prs:baseline` (the loop calls this at `add`). */
export function validate(target) {
  if (!TARGETS.has(target)) throw new Error(`pr-watch target must be "open-prs" or "open-prs:baseline", got "${target}"`);
}

const firstLine = (text) => String(text || '').split('\n')[0];

function gh(ctx, args, what) {
  const r = ctx.run('gh', args);
  if (r.status !== 0) throw new Error(`${what} failed: ${firstLine(r.stderr)}`);
  return r.stdout;
}

/** The user's login: gh_login when set, else asked of gh. */
const selfLogin = (ctx) => ctx.config?.ghLogin ?? (GH_LOGIN || gh(ctx, ['api', 'user', '--jq', '.login'], 'gh api user').trim());

/** Every open PR as a plain board keyed `owner/repo#n`, reduced to what a diff needs. */
function fetchBoard(ctx, self) {
  const owners = new Set((ctx.config?.copilotOrgs ?? COPILOT_ORGS).map((o) => o.toLowerCase()));
  // Fail closed: Copilot is requested only where the repo owner is listed in copilot_orgs (GitHub logins are case-insensitive).
  const copilotAllowed = (nameWithOwner) => owners.has(nameWithOwner.split('/')[0].toLowerCase());
  const notSelf = (login) => login && login !== self;
  const board = {};
  // Paginated: the search returns 50 PRs a page, and PRs past the first page must not look closed.
  for (const pr of searchAllPages(QUERY, ctx.run)) {
    const copilotSeen =
      pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === COPILOT) ||
      pr.latestReviews.nodes.some((r) => r.author?.login === COPILOT);
    board[`${pr.repository.nameWithOwner}#${pr.number}`] = {
      url: pr.url,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      isDraft: pr.isDraft,
      head: pr.headRefOid,
      needsCopilot: pr.isDraft && !copilotSeen && copilotAllowed(pr.repository.nameWithOwner),
      decision: pr.reviewDecision || 'NONE',
      threads: pr.reviewThreads.nodes
        .filter((t) => !t.isResolved && notSelf(t.comments.nodes[0]?.author?.login))
        .map((t) => ({ id: t.id, who: t.comments.nodes[0].author.login, url: t.comments.nodes[0].url })),
      // The newest comment on each open thread, so a reply in an existing thread wakes us too, not just new threads.
      replies: pr.reviewThreads.nodes
        .filter((t) => !t.isResolved && notSelf(t.last.nodes[0]?.author?.login))
        .map((t) => ({ id: t.last.nodes[0].id, who: t.last.nodes[0].author.login, url: t.last.nodes[0].url })),
      comments: pr.comments.nodes.filter((c) => notSelf(c.author?.login)).map((c) => ({ id: c.id, who: c.author.login, url: c.url })),
      reviews: pr.reviews.nodes
        // Copilot's review body is a summary; its actionable findings arrive as threads.
        .filter((r) => notSelf(r.author?.login) && r.author.login !== COPILOT && (r.body?.trim() || r.state !== 'COMMENTED'))
        .map((r) => ({ id: r.id, who: r.author.login, state: r.state, url: r.url })),
    };
  }
  return board;
}

// More than half the open set vanishing in one tick is a bad fetch, not a merge spree.
function looksTruncated(prev, next) {
  const before = Object.keys(prev).length;
  return before >= 4 && Object.keys(next).length < before / 2;
}

// A PR missing from one search result is only reported once GitHub confirms it is no longer open;
// a lagging search index must not look like a merge.
function confirmedClosed(pr, ctx) {
  const r = ctx.run('gh', ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'state', '-q', '.state']);
  return r.status === 0 && r.stdout.trim() !== 'OPEN';
}

// Standing conditions stay true tick after tick (an approved PR the user is deliberately holding back). Each has a stable
// id and a signature; it wakes only when its signature is new or changed, e.g. a fresh approval on a moved head.
const STANDING = [
  { kind: 'APPROVED-UNMERGED', applies: (pr) => pr.decision === 'APPROVED', signature: (pr) => pr.head || 'unknown-head' },
];

const standingConditions = (board) => STANDING.flatMap(({ kind, applies, signature }) =>
  Object.entries(board).filter(([, pr]) => applies(pr)).map(([key, pr]) => ({ id: `${kind} ${key}`, sig: signature(pr), line: `${kind} ${key} ${pr.url}` })));

/** Everything told so far, pruned to the conditions that still hold: a cleared condition wakes again if it returns. */
const reportedNow = (board) => Object.fromEntries(standingConditions(board).map((c) => [c.id, c.sig]));

// The user wants Copilot's pass resolved before they review a draft. It runs once per PR: after the request (or its review) needsCopilot is false.
function requestCopilot(board, ctx) {
  for (const [key, pr] of Object.entries(board)) {
    if (!pr.needsCopilot) continue;
    const r = ctx.run('gh', ['pr', 'edit', String(pr.number), '--repo', pr.repo, '--add-reviewer', '@copilot']);
    if (r.status === 0) pr.needsCopilot = false;
    else console.error(`copilot request failed for ${key}: ${firstLine(r.stderr)}`);
  }
}

/** The snapshot before this install moved into the loop: pr-review kept { board, reported } in its own file, which we adopt once. */
function legacySnapshot(ctx) {
  const file = ctx.dir && ctx.watch ? join(ctx.dir, `pr-review-${ctx.watch.id}.json`) : '';
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return 'board' in raw ? { board: raw.board || {}, reported: raw.reported || {} } : { board: raw, reported: {} };
  } catch { return null; }
}

/** The previous snapshot, or null: a state from the old wrapper (no board) falls back to its state file, else counts as a first check. */
const previous = (ctx) => (ctx.prev?.board ? ctx.prev : legacySnapshot(ctx));

export function check(target, ctx) {
  const prev = previous(ctx);
  const board = fetchBoard(ctx, selfLogin(ctx));
  if (prev && looksTruncated(prev.board, board)) {
    throw new Error(`search returned ${Object.keys(board).length} of ${Object.keys(prev.board).length} PRs; skipping tick`);
  }
  requestCopilot(board, ctx);
  const left = prev ? Object.entries(prev.board).filter(([key, pr]) => !board[key] && confirmedClosed(pr, ctx)).map(([key, pr]) => `LEFT-OPEN-SET ${key} (merged or closed) ${pr.url}`) : [];
  // `reported` is what this snapshot's standing conditions look like once told (so the next diff stays quiet about them).
  // A silent (baseline) first check reports nothing at all; a normal first check has told nobody yet, so diff() speaks.
  // `carried` hands diff() the old file's snapshot when that is what this check compared against.
  const state = { board, reported: reportedNow(board), left, silent: !prev && target === 'open-prs:baseline' };
  return prev && !ctx.prev?.board ? { ...state, carried: prev } : state;
}

/** The lines for what changed between two boards, newest state last. */
function changesBetween(prev, next) {
  const lines = [];
  for (const [key, pr] of Object.entries(next)) {
    const old = prev[key];
    const seen = (list, id) => (old ? (old[list] || []).some((x) => x.id === id) : false);
    // NONE <-> REVIEW_REQUIRED flips whenever threads resolve or commits land; only a move into or out of APPROVED / CHANGES_REQUESTED is worth waking for.
    const quiet = new Set(['NONE', 'REVIEW_REQUIRED']);
    if (old && old.decision !== pr.decision && !(quiet.has(old.decision) && quiet.has(pr.decision))) lines.push(`DECISION ${key}: ${old.decision} -> ${pr.decision} ${pr.url}`);
    for (const t of pr.threads) if (!seen('threads', t.id)) lines.push(`THREAD ${key} by ${t.who}: ${t.url}`);
    const newThreadUrls = new Set(pr.threads.filter((t) => !seen('threads', t.id)).map((t) => t.url));
    for (const r of pr.replies || []) if (!seen('replies', r.id) && !newThreadUrls.has(r.url)) lines.push(`REPLY ${key} by ${r.who}: ${r.url}`);
    for (const c of pr.comments) if (!seen('comments', c.id)) lines.push(`COMMENT ${key} by ${c.who}: ${c.url}`);
    for (const r of pr.reviews) if (!seen('reviews', r.id)) lines.push(`REVIEW ${key} by ${r.who} (${r.state}): ${r.url}`);
  }
  return lines;
}

/**
 * diff(null, next) is the first check: nothing "changed", but standing conditions not yet told about are worth waking for
 * (none at all after a baseline). A prev without a board is the pre-loop shape: next.carried then holds the snapshot adopted from its file.
 */
export function diff(prev, next) {
  const base = prev?.board ? prev : next.carried;
  if (next.silent && !base) return [];
  const before = base?.board ?? next.board;
  const told = base?.reported ?? {};
  const fresh = standingConditions(next.board).filter((c) => told[c.id] !== c.sig).map((c) => c.line);
  return [...changesBetween(before, next.board), ...(next.left ?? []), ...fresh].map((summary) => ({ summary }));
}

/** The loop calls this when the watch retires or is removed: drop the state file an older pr-review kept. */
export const retired = (watch, ctx) => rmSync(join(ctx.dir, `pr-review-${watch.id}.json`), { force: true });

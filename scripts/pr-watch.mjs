#!/usr/bin/env node
/**
 * pr-watch.mjs: a cheap PR poller for the-maestro.
 *
 * Every tick, fetch the user's open PRs (scoped by local-config.mjs) with one
 * `gh api graphql` call and compare them against a stored state file. Stay silent
 * and keep looping while nothing changes. Exit 0 with a short report as soon as
 * something needs attention, so a background run wakes the orchestrator only
 * when there is work to do. This costs no tokens between changes.
 *
 * "Needs attention" means:
 *   - a new unresolved review thread, from anyone but the user (bots included);
 *   - a new reply in an open thread, from anyone but the user;
 *   - a new top-level PR comment or review body from anyone but the user;
 *   - a reviewDecision flip, e.g. to APPROVED or CHANGES_REQUESTED;
 *   - a PR that left the open set (merged or closed).
 * Standing conditions (an approved PR left unmerged) wake once, when they first appear or change
 * (a new approval, a moved head), then stay quiet; every report still lists them.
 *
 * Each tick also requests a Copilot review on any draft PR that Copilot hasn't
 * reviewed and isn't already requested on. Its threads then arrive as THREAD lines.
 *
 *   pr-watch.mjs [--interval N] [--once] [--baseline] --state <file>
 *     --interval  pin the poll to N seconds; by default the cadence adapts to activity and
 *                 quiet hours (scripts/lib/cadence.mjs, settings watch_* in local-config)
 *     --baseline  record the current state and exit, without reporting
 *     --once      check a single time and exit (report or "no changes")
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  GH_LOGIN, PR_SEARCH, WATCH_MAX_INTERVAL, WATCH_MIN_INTERVAL, WATCH_QUIET_HOURS, WATCH_QUIET_HOURS_MODE,
  WATCH_QUIET_WEEKENDS, WATCH_TZ,
} from './local-config.mjs';
import { floorSeconds, nextInterval } from './lib/cadence.mjs';
import { searchAllPages } from './lib/gh-search.mjs';

// Exit codes: 0 means "attention needed" (stdout has the report) or a finished --once check.
const EXIT = { attention: 0, usage: 2, quietStop: 3 };
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

// --interval must be a positive number of seconds; anything else is a usage error, not "unpinned".
function parsePin(text) {
  if (text === undefined) return undefined;
  const seconds = Number(text);
  if (text.trim() !== '' && Number.isFinite(seconds) && seconds > 0) return seconds;
  console.error(`--interval needs a positive number of seconds, got "${text}".`);
  process.exit(EXIT.usage);
}

const SELF = GH_LOGIN || execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
const COPILOT = 'copilot-pull-request-reviewer';
// The cadence adapts to activity and quiet hours (lib/cadence.mjs); --interval N pins it instead.
const PINNED_S = parsePin(opt('--interval'));
const CADENCE = {
  minInterval: WATCH_MIN_INTERVAL,
  maxInterval: WATCH_MAX_INTERVAL,
  quietHours: WATCH_QUIET_HOURS,
  quietMode: WATCH_QUIET_HOURS_MODE,
  quietWeekends: WATCH_QUIET_WEEKENDS,
  tz: WATCH_TZ,
  pinned: PINNED_S,
  watchingSince: Date.now(),
};
if (PINNED_S !== undefined && PINNED_S < floorSeconds({ minInterval: WATCH_MIN_INTERVAL })) {
  console.error(`--interval ${PINNED_S} is below the ${floorSeconds({ minInterval: WATCH_MIN_INTERVAL })}s floor; polling every ${floorSeconds({ minInterval: WATCH_MIN_INTERVAL })}s.`);
}
const EVENT_HISTORY_MS = 6 * 3600 * 1000;
// Recent events, plus the newest one however old: it is what idleness is measured from, so the
// backoff carries across restarts.
const trimEvents = (events) => {
  const newest = Math.max(...events);
  return events.filter((t) => t === newest || Date.now() - t < EVENT_HISTORY_MS);
};
const STATE = opt('--state');
if (!STATE) {
  console.error('Pass --state <file>.');
  process.exit(EXIT.usage);
}

const QUERY = `query($after: String) { search(query: "${PR_SEARCH}", type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number url isDraft reviewDecision headRefOid repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on Bot { login } } } }
  latestReviews(first: 20) { nodes { author { login } } }
  reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { author { login } url } } last: comments(last: 1) { nodes { id author { login } url } } } }
  comments(last: 20) { nodes { id author { login } url } }
  reviews(last: 20) { nodes { id author { login } state body url } }
} } } }`;

function fetchBoard() {
  // Paginated: the search returns 50 PRs a page, and PRs past the first page must not look closed.
  const board = {};
  for (const pr of searchAllPages(QUERY)) {
    const key = `${pr.repository.nameWithOwner}#${pr.number}`;
    const notSelf = (login) => login && login !== SELF;
    const copilotSeen =
      pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === COPILOT) ||
      pr.latestReviews.nodes.some((r) => r.author?.login === COPILOT);
    board[key] = {
      url: pr.url,
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      isDraft: pr.isDraft,
      head: pr.headRefOid,
      needsCopilot: pr.isDraft && !copilotSeen,
      decision: pr.reviewDecision || 'NONE',
      threads: pr.reviewThreads.nodes
        .filter((t) => !t.isResolved && notSelf(t.comments.nodes[0]?.author?.login))
        .map((t) => ({ id: t.id, who: t.comments.nodes[0].author.login, url: t.comments.nodes[0].url })),
      // The newest comment on each open thread, so a reply in an existing thread
      // (a reviewer answering our reply, say) wakes us too, not just new threads.
      replies: pr.reviewThreads.nodes
        .filter((t) => !t.isResolved && notSelf(t.last.nodes[0]?.author?.login))
        .map((t) => ({ id: t.last.nodes[0].id, who: t.last.nodes[0].author.login, url: t.last.nodes[0].url })),
      comments: pr.comments.nodes
        .filter((c) => notSelf(c.author?.login))
        .map((c) => ({ id: c.id, who: c.author.login, url: c.url })),
      reviews: pr.reviews.nodes
        // Copilot's review body is a summary; its actionable findings arrive as threads.
        .filter((r) => notSelf(r.author?.login) && r.author.login !== COPILOT && (r.body?.trim() || r.state !== 'COMMENTED'))
        .map((r) => ({ id: r.id, who: r.author.login, state: r.state, url: r.url })),
    };
  }
  return board;
}

function diff(prev, next) {
  const lines = [];
  for (const [key, pr] of Object.entries(next)) {
    const old = prev[key];
    const seen = (list, id) => (old ? (old[list] || []).some((x) => x.id === id) : false);
    // NONE <-> REVIEW_REQUIRED flips whenever threads resolve or commits land; only
    // a move into or out of APPROVED / CHANGES_REQUESTED is worth waking up for.
    const quiet = new Set(['NONE', 'REVIEW_REQUIRED']);
    const meaningful = old && old.decision !== pr.decision && !(quiet.has(old.decision) && quiet.has(pr.decision));
    if (meaningful) lines.push(`DECISION ${key}: ${old.decision} -> ${pr.decision} ${pr.url}`);
    for (const t of pr.threads) if (!seen('threads', t.id)) lines.push(`THREAD ${key} by ${t.who}: ${t.url}`);
    const newThreadUrls = new Set(pr.threads.filter((t) => !seen('threads', t.id)).map((t) => t.url));
    for (const r of pr.replies || []) {
      if (!seen('replies', r.id) && !newThreadUrls.has(r.url)) lines.push(`REPLY ${key} by ${r.who}: ${r.url}`);
    }
    for (const c of pr.comments) if (!seen('comments', c.id)) lines.push(`COMMENT ${key} by ${c.who}: ${c.url}`);
    for (const r of pr.reviews) if (!seen('reviews', r.id)) lines.push(`REVIEW ${key} by ${r.who} (${r.state}): ${r.url}`);
  }
  for (const key of Object.keys(prev)) {
    if (!next[key] && confirmedClosed(prev[key])) lines.push(`LEFT-OPEN-SET ${key} (merged or closed) ${prev[key].url}`);
  }
  return lines;
}

// Things that happened since the last tick, for the cadence: each wake-worthy change, plus the
// quiet ones (a push moving the head, a PR going draft <-> ready).
function quietEvents(prev, next) {
  return Object.entries(next).filter(([key, pr]) => prev[key] && (prev[key].head !== pr.head || prev[key].isDraft !== pr.isDraft)).length;
}

// A PR missing from one search result is only reported once GitHub confirms it
// is no longer open; a lagging search index must not look like a merge.
function confirmedClosed(pr) {
  try {
    const state = execFileSync('gh', ['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'state', '-q', '.state'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return state !== 'OPEN';
  } catch {
    return false;
  }
}

// More than half the open set vanishing in one tick is a bad fetch, not a merge spree.
function looksTruncated(prev, next) {
  const before = Object.keys(prev).length;
  return before >= 4 && Object.keys(next).length < before / 2;
}

// Standing conditions are states that stay true tick after tick (an approved PR the user is
// deliberately holding back). Each has a stable id and a signature; it wakes the orchestrator
// only when its signature is new or changed, e.g. a fresh approval on a moved head. Add new
// kinds of standing condition here and they inherit the report-once behaviour.
const STANDING = [
  {
    kind: 'APPROVED-UNMERGED',
    applies: (pr) => pr.decision === 'APPROVED',
    signature: (pr) => pr.head || 'unknown-head',
  },
];

function standingConditions(board) {
  return STANDING.flatMap(({ kind, applies, signature }) =>
    Object.entries(board)
      .filter(([, pr]) => applies(pr))
      .map(([key, pr]) => ({ id: `${kind} ${key}`, sig: signature(pr), line: `${kind} ${key} ${pr.url}` })),
  );
}

const standingLines = (board) => standingConditions(board).map((c) => c.line);

// Which standing conditions the user has not yet been told about in this exact form.
const unreported = (board, reported) => standingConditions(board).filter((c) => reported[c.id] !== c.sig);

// Everything reported so far, pruned to the conditions that still hold: a cleared condition
// is forgotten so it wakes again if it comes back.
const reportedNow = (board) => Object.fromEntries(standingConditions(board).map((c) => [c.id, c.sig]));

// The user wants Copilot's pass resolved before they review a draft, so request Copilot
// on any draft it has neither reviewed nor been asked to review. It runs once per
// PR: after that the request (or its review) makes needsCopilot false.
function requestCopilot(board) {
  const requested = [];
  for (const [key, pr] of Object.entries(board)) {
    if (!pr.needsCopilot) continue;
    try {
      execFileSync('gh', ['pr', 'edit', String(pr.number), '--repo', pr.repo, '--add-reviewer', '@copilot'], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      pr.needsCopilot = false;
      requested.push(key);
    } catch (err) {
      console.error(`copilot request failed for ${key}: ${err.message.split('\n')[0]}`);
    }
  }
  if (requested.length) console.error(`${new Date().toISOString()} requested Copilot on: ${requested.join(', ')}`);
  return requested;
}

// State file: { board, reported, events }. A legacy file is the bare board (keys look like owner/repo#n).
// A truncated file or a literal null is a warning and a fresh start (null), never a crash.
const load = () => {
  if (!existsSync(STATE)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(STATE, 'utf8'));
  } catch (err) {
    console.error(`state file ${STATE} is unreadable (${err.message.split('\n')[0]}); starting from an empty board`);
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.error(`state file ${STATE} is not an object; starting from an empty board`);
    return null;
  }
  return 'board' in raw ? { board: raw.board || {}, reported: raw.reported || {}, events: raw.events || [] } : { board: raw, reported: {}, events: [] };
};
// Written to a temp file and renamed over the state, so a crash mid-write cannot leave it truncated.
const save = (board, reported, events, extra = {}) => {
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ board, reported, events, ...extra }, null, 2));
  renameSync(tmp, STATE);
};
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Decides the next sleep from recent activity, says so on stderr, and sleeps unless told to stop.
// Returns false when the cadence says to exit (quiet hours).
function schedule(events) {
  const next = nextInterval({ now: Date.now(), recentEvents: events, config: CADENCE });
  console.error(next.stop ? `stopping: ${next.reason}` : `next check in ${next.seconds}s (${next.reason})`);
  return next;
}

// A quiet-hours stop is not "attention needed": say so on stdout, record it, and exit 3.
function quietStop(next) {
  const { board, reported, events } = load() ?? { board: {}, reported: {}, events: [] };
  save(board, reported, events, { stoppedForQuietAt: new Date().toISOString() });
  console.log(`QUIET-HOURS stop until ${next.until} ${next.tz}`);
  process.exitCode = EXIT.quietStop;
}
async function wait(events) {
  const next = schedule(events);
  if (next.stop) {
    quietStop(next);
    return false;
  }
  await sleep(next.seconds);
  return true;
}

async function main() {
  if (flag('--baseline') || !load()) {
    const board = fetchBoard();
    // A baseline prints the standing conditions, so they count as reported; a silent first
    // run has told the user nothing yet and reports them on its first tick.
    save(board, flag('--baseline') ? reportedNow(board) : {}, []);
    if (flag('--baseline')) {
      console.log(`baseline: ${Object.keys(board).length} open PRs`);
      standingLines(board).forEach((l) => console.log(l));
      return;
    }
  }
  for (;;) {
    let board;
    const events = trimEvents(load()?.events || []);
    try {
      board = fetchBoard();
    } catch (err) {
      // Network blips and gh rate limits are transient; wait and retry.
      console.error(`fetch failed, retrying next tick: ${err.message.split('\n')[0]}`);
      if (!(await wait(events))) return;
      continue;
    }
    const { board: prev, reported } = load() ?? { board: {}, reported: {} };
    if (looksTruncated(prev, board)) {
      console.error(`${new Date().toISOString()} search returned ${Object.keys(board).length} of ${Object.keys(prev).length} PRs; skipping tick`);
      if (!(await wait(events))) return;
      continue;
    }
    requestCopilot(board);
    const changes = diff(prev, board);
    const fresh = unreported(board, reported);
    const seen = changes.length + quietEvents(prev, board);
    const history = trimEvents([...events, ...Array(seen).fill(Date.now())]);
    save(board, reportedNow(board), history);
    if (changes.length || fresh.length) {
      console.log(`${new Date().toISOString()} ${changes.length + fresh.length} change(s):`);
      changes.forEach((l) => console.log(l));
      standingLines(board).forEach((l) => console.log(l));
      console.error('exiting: something needs attention');
      process.exitCode = EXIT.attention;
      return;
    }
    if (flag('--once')) {
      console.log('no changes');
      standingLines(board).forEach((l) => console.log(l));
      schedule(history);
      return;
    }
    if (!(await wait(history))) return;
  }
}

main();

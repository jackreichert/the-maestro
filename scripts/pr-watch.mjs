#!/usr/bin/env node
/**
 * pr-watch.mjs: a cheap PR poller for the-maestro.
 *
 * Every --interval seconds (default 300), fetch the user's open PRs (scoped by local-config.mjs) with one
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
 * Every report also lists approved-but-unmerged PRs.
 *
 * Each tick also requests a Copilot review on any draft PR that Copilot hasn't
 * reviewed and isn't already requested on. Its threads then arrive as THREAD lines.
 *
 *   pr-watch.mjs [--interval 300] [--once] [--baseline] --state <file>
 *     --baseline  record the current state and exit, without reporting
 *     --once      check a single time and exit (report or "no changes")
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GH_LOGIN, PR_SEARCH } from './local-config.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const SELF = GH_LOGIN || execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
const COPILOT = 'copilot-pull-request-reviewer';
const INTERVAL_S = Number(opt('--interval', '300'));
const STATE = opt('--state');
if (!STATE) {
  console.error('Pass --state <file>.');
  process.exit(2);
}

const QUERY = `query { search(query: "${PR_SEARCH}", type: ISSUE, first: 50) { nodes { ... on PullRequest {
  number url isDraft reviewDecision repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on Bot { login } } } }
  latestReviews(first: 20) { nodes { author { login } } }
  reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { author { login } url } } last: comments(last: 1) { nodes { id author { login } url } } } }
  comments(last: 20) { nodes { id author { login } url } }
  reviews(last: 20) { nodes { id author { login } state body url } }
} } } }`;

function fetchBoard() {
  const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  // Under load GitHub can answer 200 with `errors` and an empty or partial search;
  // treat that as a failed fetch, never as "every PR closed" (dev-env-012).
  if (parsed.errors?.length || !parsed.data?.search) {
    throw new Error(`partial GraphQL response: ${parsed.errors?.[0]?.message || 'no search data'}`);
  }
  const board = {};
  for (const pr of parsed.data.search.nodes.filter(Boolean)) {
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

function approvedUnmerged(board) {
  return Object.entries(board)
    .filter(([, pr]) => pr.decision === 'APPROVED')
    .map(([key, pr]) => `APPROVED-UNMERGED ${key} ${pr.url}`);
}

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

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const save = (board) => writeFileSync(STATE, JSON.stringify(board, null, 2));
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  if (flag('--baseline') || !load()) {
    const board = fetchBoard();
    save(board);
    if (flag('--baseline')) {
      console.log(`baseline: ${Object.keys(board).length} open PRs`);
      approvedUnmerged(board).forEach((l) => console.log(l));
      return;
    }
  }
  for (;;) {
    let board;
    try {
      board = fetchBoard();
    } catch (err) {
      // Network blips and gh rate limits are transient; wait and retry.
      console.error(`fetch failed, retrying next tick: ${err.message.split('\n')[0]}`);
      await sleep(INTERVAL_S);
      continue;
    }
    const prev = load();
    if (looksTruncated(prev, board)) {
      console.error(`${new Date().toISOString()} search returned ${Object.keys(board).length} of ${Object.keys(prev).length} PRs; skipping tick`);
      await sleep(INTERVAL_S);
      continue;
    }
    requestCopilot(board);
    const changes = diff(prev, board);
    save(board);
    if (changes.length) {
      console.log(`${new Date().toISOString()} ${changes.length} change(s):`);
      changes.forEach((l) => console.log(l));
      approvedUnmerged(board).forEach((l) => console.log(l));
      return;
    }
    if (flag('--once')) {
      console.log('no changes');
      approvedUnmerged(board).forEach((l) => console.log(l));
      return;
    }
    await sleep(INTERVAL_S);
  }
}

main();

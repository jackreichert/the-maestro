#!/usr/bin/env node
/**
 * Mid-day PR snapshot + diff for the-maestro's PR tracking (reference/prs.md).
 *
 * Runs the same `gh api graphql` query prs.md documents, saves the result as a
 * JSON snapshot, and — with --diff — reports only the ACTIONABLE changes since
 * the last snapshot: a new human review (APPROVED / CHANGES_REQUESTED /
 * COMMENTED by a non-bot), a `reviewDecision` flip, a new unresolved thread
 * opened by a human, a PR that merged or closed, or a draft promoted to ready.
 * Bot activity (Copilot, Aikido, anything `login[bot]`) is summarised as one
 * count line, never itemised — see reference/prs.md#mid-day-updates.
 *
 * Storage is fixed at $LEDGER_ROOT/Projects/<CONTAINER_PROJECT>/Journal/prs-snapshot.json
 * (moved out of the vault on 2026-09-26 so the ledger stays out of Obsidian
 * search; falls back to $VAULT_ROOT if LEDGER_ROOT is unset).
 * This tracks the org-wide PR board, not a single repo's ledger, so unlike
 * journal.mjs there is no --project flag — the container's own project name
 * (CONTAINER_PROJECT in local-config.ts) is the only one that makes sense here.
 *
 *   prs-snapshot.ts [--diff] [--dry-run] --vault <path>
 *       Fetch the live board via `gh api graphql`. With --diff, compare it
 *       against the stored snapshot first and print the actionable changes.
 *       Either way (unless --dry-run), overwrite the snapshot with the fresh
 *       fetch, so the next run diffs against this one.
 *       Root precedence: --vault, then $LEDGER_ROOT, then $VAULT_ROOT.
 *
 *   prs-snapshot.ts [--diff] [--ready] ...   --ready adds the readiness report: PRs that are ready to merge, and approved ones that are not, with why
 *   prs-snapshot.ts ready <snapshot.json>   the readiness report for a snapshot on disk (no network; it says how old the file is and is not a merge gate)
 *
 *   prs-snapshot.ts diff <old-snapshot.json> <new-snapshot.json>
 *       Pure diff of two snapshot files already on disk. No network call, no
 *       write. This is what the test file exercises.
 *
 * Cadence (reference/prs.md#mid-day-updates): take a plain snapshot as part of
 * the morning board, then `--diff` at mid-day and again in the end-of-day PR
 * pass (reference/ledger.md#pr-pass).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTAINER_PROJECT, LEDGER_ROOT, PR_SEARCH, TWIN_FLOW_REPOS, VAULT_ROOT } from './local-config.ts';
import { searchAllPages } from './lib/gh-search.ts';

// Keep the bot list in one place: a literal suffix every GitHub App login
// carries, plus the two reviewer accounts we see that don't.
const BOTS = {
    suffix: '[bot]',
    logins: ['copilot-pull-request-reviewer', 'aikido-pr-checks'],
};
const isBot = (login) => !login || login.endsWith(BOTS.suffix) || BOTS.logins.includes(login);

const HUMAN_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

const argv = process.argv.slice(2);
const cmd = ['diff', 'ready'].includes(argv[0]) ? argv[0] : 'snapshot';
const positional = argv.slice(cmd === 'snapshot' ? 0 : 1).filter((a) => !a.startsWith('--'));
function arg(name, fallback = null) {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

// The same query reference/prs.md documents, extended with the two fields the
// human-readable board's --jq ignores but a diff needs for stable identity:
// reviewThreads.nodes[].id and latestReviews.nodes[].submittedAt.
const QUERY = `query($after: String) {
  search(query: "${PR_SEARCH}", type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        isDraft
        url
        headRefName
        baseRefName
        updatedAt
        reviewDecision
        mergeable
        repository { nameWithOwner }
        reviewRequests(first: 10) {
          nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } }
        }
        latestReviews(first: 10) {
          nodes { author { login } state submittedAt }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes { id isResolved isOutdated comments(first: 1) { nodes { author { login } } } }
        }
        comments(last: 5) { totalCount nodes { author { login } createdAt } }
      }
    }
  }
}`;

// Flatten one search node into the snapshot shape (key and the fields diffSnapshots reads).
const toSnapshotPr = (n) => ({
    key: `${n.repository.nameWithOwner}#${n.number}`,
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    url: n.url,
    isDraft: n.isDraft,
    headRefName: n.headRefName,
    baseRefName: n.baseRefName,
    updatedAt: n.updatedAt,
    reviewDecision: n.reviewDecision || 'NONE',
    mergeable: n.mergeable || 'UNKNOWN',
    threadsComplete: !n.reviewThreads.pageInfo?.hasNextPage,
    reviewers: n.reviewRequests.nodes.map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter((x) => x != null),
    reviews: n.latestReviews.nodes.map((r) => ({ author: r.author?.login, state: r.state, submittedAt: r.submittedAt })),
    threads: n.reviewThreads.nodes.map((t) => ({ id: t.id, isResolved: t.isResolved, isOutdated: t.isOutdated, author: t.comments.nodes[0]?.author?.login })),
    commentTotal: n.comments.totalCount,
});

function fetchLive() {
    // Every page: a single 50-result page made PRs past the 50th look "no longer open".
    return { takenAt: new Date().toISOString(), prs: searchAllPages(QUERY).map(toSnapshotPr) };
}

function loadSnapshot(path) {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Pure diff — no I/O, no network, fixture-testable. Returns
 * { changes: string[], botEvents: number }. `changes` holds only the
 * actionable lines prs.md#mid-day-updates asks for; everything bot-authored
 * folds into the single `botEvents` count instead of being itemised.
 */
function diffSnapshots(prev, curr) {
    const prevByKey = new Map((prev?.prs || []).map((p) => [p.key, p]));
    const currKeys = new Set(curr.prs.map((p) => p.key));
    const changes = [];
    let botEvents = 0;

    for (const p of curr.prs) {
        const old = prevByKey.get(p.key);
        if (!old) continue; // a brand-new PR isn't one of the watched actionable events

        if (old.isDraft && !p.isDraft) {
            changes.push(`${p.key} draft promoted to ready for review — ${p.url}`);
        }
        if (old.reviewDecision !== p.reviewDecision) {
            changes.push(`${p.key} reviewDecision ${old.reviewDecision} -> ${p.reviewDecision} — ${p.url}`);
        }

        const oldReviewKeys = new Set(old.reviews.map((r) => `${r.author}|${r.state}|${r.submittedAt}`));
        for (const r of p.reviews) {
            if (oldReviewKeys.has(`${r.author}|${r.state}|${r.submittedAt}`)) continue;
            if (isBot(r.author)) { botEvents++; continue; }
            if (HUMAN_REVIEW_STATES.has(r.state)) {
                changes.push(`${p.key} new review: ${r.author} ${r.state} — ${p.url}`);
            }
        }

        const oldThreadIds = new Set(old.threads.map((t) => t.id));
        for (const t of p.threads) {
            if (oldThreadIds.has(t.id)) continue;
            if (isBot(t.author)) { botEvents++; continue; }
            if (!t.isResolved) {
                changes.push(`${p.key} new thread opened by ${t.author} — ${p.url}`);
            }
        }
    }

    for (const [key, old] of prevByKey) {
        if (!currKeys.has(key)) {
            changes.push(`${key} no longer open (merged or closed) — ${old.url}`);
        }
    }

    return { changes, botEvents };
}

// ── readiness ───────────────────────────────────────────────────────────────

/** Branch the release-candidate twin targets in twin-flow repos (git.md "Twin PRs"); its integration twin targets any other base. */
const RELEASE_BRANCH = 'staging';

/**
 * Why a PR is not ready to merge, from data alone: { ready, reasons }. Ready means not a draft, approved, zero unresolved
 * review threads (and all threads read), GitHub says MERGEABLE, and, in a twin-flow repo, a release-candidate PR has no open
 * integration twin (same repo and head branch, another base). A conflict or open thread never reads as ready.
 */
export function readiness(pr, all = [], twinRepos = TWIN_FLOW_REPOS) {
    const reasons = [];
    if (pr.isDraft) reasons.push('draft');
    if (pr.reviewDecision !== 'APPROVED') reasons.push(`not approved (${pr.reviewDecision})`);
    const open = (pr.threads || []).filter((t) => !t.isResolved).length;
    if (open) reasons.push(`${open} unresolved review thread(s)`);
    if (pr.threadsComplete === false) reasons.push('more than 100 review threads, not all read');
    if (pr.mergeable === 'CONFLICTING') reasons.push('merge conflict');
    else if (pr.mergeable !== 'MERGEABLE') reasons.push(`mergeable state ${pr.mergeable || 'unknown'}`);
    if (twinRepos.includes(pr.repo) && pr.baseRefName === RELEASE_BRANCH) {
        const twin = all.find((o) => o.repo === pr.repo && o.headRefName === pr.headRefName && o.baseRefName !== RELEASE_BRANCH);
        if (twin) reasons.push(`blocked on ${twin.baseRefName} twin #${twin.number}`);
    }
    return { ready: reasons.length === 0, reasons };
}

/** Lines for the ready bucket, and for every approved PR that is not ready with its reasons (so none vanishes). */
export function readyLines(snapshot, twinRepos = TWIN_FLOW_REPOS) {
    const rows = snapshot.prs.map((p) => ({ p, ...readiness(p, snapshot.prs, twinRepos) }));
    const ready = rows.filter((r) => r.ready);
    const held = rows.filter((r) => !r.ready && r.p.reviewDecision === 'APPROVED');
    return [
        `Ready to merge (${ready.length}):`, ...ready.map((r) => `  ${r.p.key} — ${r.p.url}`),
        `Approved but not ready (${held.length}):`, ...held.map((r) => `  ${r.p.key} — ${r.reasons.join('; ')} — ${r.p.url}`),
    ];
}

const defaultRun = (args) => spawnSync('gh', args, { encoding: 'utf8' });
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * After a PR merged, its open siblings in the same repos have a new base, so the `mergeable` the board query returned may be
 * a cached answer from before the merge (GitHub recomputes lazily, and says UNKNOWN until asked again). Each such sibling is
 * set to UNKNOWN, then re-asked through `gh pr view` until two answers in a row agree and are known (4 tries at most). A lookup
 * that fails or never settles leaves it UNKNOWN, which readiness() does not call ready.
 */
export function requerySiblings(prev, curr, { run = defaultRun, wait = pause } = {}) {
    const open = new Set(curr.prs.map((p) => p.key));
    const mergedRepos = new Set((prev?.prs || []).filter((p) => !open.has(p.key)).map((p) => p.repo));
    for (const p of curr.prs.filter((x) => mergedRepos.has(x.repo))) {
        p.mergeable = 'UNKNOWN';
        let last = '';
        for (let attempt = 0; attempt < 4; attempt++) {
            const r = run(['pr', 'view', String(p.number), '--repo', p.repo, '--json', 'mergeable', '--jq', '.mergeable']);
            const state = r.status === 0 ? String(r.stdout).trim() : '';
            if (!state) break;
            if (state !== 'UNKNOWN' && state === last) { p.mergeable = state; break; }
            last = state;
            wait(1500);
        }
    }
    return [...mergedRepos];
}

function printDiff({ changes, botEvents }) {
    if (!changes.length && !botEvents) {
        console.log('No actionable changes since last snapshot.');
        return;
    }
    if (changes.length) {
        console.log('Actionable changes:');
        changes.forEach((c) => console.log(`  - ${c}`));
    } else {
        console.log('No actionable changes since last snapshot.');
    }
    if (botEvents) {
        console.log(`\n${botEvents} bot-only update(s) (reviews/threads) — no action needed.`);
    }
}

function cmdSnapshot() {
    const vault = arg('vault', LEDGER_ROOT || VAULT_ROOT);
    if (!vault) {
        console.error('Pass --vault <path> (the ledger root), or set LEDGER_ROOT (or VAULT_ROOT).');
        process.exit(1);
    }
    const dir = join(vault, 'Projects', CONTAINER_PROJECT, 'Journal');
    const path = join(dir, 'prs-snapshot.json');

    const prev = loadSnapshot(path);
    const curr = fetchLive();
    requerySiblings(prev, curr);

    if (has('diff')) {
        if (!prev) {
            console.log('No previous snapshot — nothing to diff. This run establishes the baseline.');
        } else {
            printDiff(diffSnapshots(prev, curr));
        }
    }

    if (has('ready')) readyLines(curr).forEach((l) => console.log(l));

    if (!has('dry-run')) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(curr, null, 2) + '\n');
        console.log(`wrote ${path}`);
    }
}

function cmdDiffFiles() {
    const [oldPath, newPath] = positional;
    if (!oldPath || !newPath) {
        console.error('Usage: prs-snapshot.ts diff <old-snapshot.json> <new-snapshot.json>');
        process.exit(1);
    }
    const prev = JSON.parse(readFileSync(oldPath, 'utf8'));
    const curr = JSON.parse(readFileSync(newPath, 'utf8'));
    printDiff(diffSnapshots(prev, curr));
}

function cmdReadyFile() {
    if (!positional[0]) { console.error('Usage: prs-snapshot.ts ready <snapshot.json>'); process.exit(1); }
    const snapshot = JSON.parse(readFileSync(positional[0], 'utf8'));
    const ageMin = snapshot.takenAt ? Math.round((Date.now() - Date.parse(snapshot.takenAt)) / 6e4) : null;
    console.log(`Snapshot taken ${snapshot.takenAt || 'at an unknown time'}${ageMin > 60 ? ` (${ageMin} minutes ago: STALE)` : ''}. Not a merge gate: run \`prs-snapshot.ts --ready\` for a live answer.`);
    readyLines(snapshot).forEach((l) => console.log(l));
}

// ── dispatch ────────────────────────────────────────────────────────────────

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
    if (cmd === 'diff') cmdDiffFiles();
    else if (cmd === 'ready') cmdReadyFile();
    else cmdSnapshot();
}

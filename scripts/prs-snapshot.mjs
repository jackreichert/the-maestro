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
 * Storage is fixed at $VAULT_ROOT/Projects/dev-env/Journal/prs-snapshot.json.
 * This tracks the org-wide PR board, not a single repo's ledger, so unlike
 * journal.mjs there is no --project flag — the container's own project name
 * ("dev-env") is the only one that makes sense here.
 *
 *   prs-snapshot.mjs [--diff] [--dry-run] --vault <path>
 *       Fetch the live board via `gh api graphql`. With --diff, compare it
 *       against the stored snapshot first and print the actionable changes.
 *       Either way (unless --dry-run), overwrite the snapshot with the fresh
 *       fetch, so the next run diffs against this one.
 *
 *   prs-snapshot.mjs diff <old-snapshot.json> <new-snapshot.json>
 *       Pure diff of two snapshot files already on disk. No network call, no
 *       write. This is what the test file exercises.
 *
 * Cadence (reference/prs.md#mid-day-updates): take a plain snapshot as part of
 * the morning board, then `--diff` at mid-day and again in the end-of-day PR
 * pass (reference/ledger.md#pr-pass).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Keep the bot list in one place: a literal suffix every GitHub App login
// carries, plus the two reviewer accounts we see that don't.
const BOTS = {
    suffix: '[bot]',
    logins: ['copilot-pull-request-reviewer', 'aikido-pr-checks'],
};
const isBot = (login) => !login || login.endsWith(BOTS.suffix) || BOTS.logins.includes(login);

const HUMAN_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

const argv = process.argv.slice(2);
const cmd = argv[0] === 'diff' ? 'diff' : 'snapshot';
const positional = argv.slice(cmd === 'diff' ? 1 : 0).filter((a) => !a.startsWith('--'));
function arg(name, fallback = null) {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

// The same query reference/prs.md documents, extended with the two fields the
// human-readable board's --jq ignores but a diff needs for stable identity:
// reviewThreads.nodes[].id and latestReviews.nodes[].submittedAt.
const QUERY = `query {
  search(query: "is:pr is:open author:@me org:ORG", type: ISSUE, first: 50) {
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
        repository { nameWithOwner }
        reviewRequests(first: 10) {
          nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } }
        }
        latestReviews(first: 10) {
          nodes { author { login } state submittedAt }
        }
        reviewThreads(first: 100) {
          nodes { id isResolved isOutdated comments(first: 1) { nodes { author { login } } } }
        }
        comments(last: 5) { totalCount nodes { author { login } createdAt } }
      }
    }
  }
}`;

const JQ = `
  .data.search.nodes[] |
  {
    key: "\\(.repository.nameWithOwner)#\\(.number)",
    repo: .repository.nameWithOwner,
    number, title, url, isDraft, headRefName, baseRefName, updatedAt,
    reviewDecision: (.reviewDecision // "NONE"),
    reviewers: [.reviewRequests.nodes[].requestedReviewer | (.login // .name) | select(. != null)],
    reviews: [.latestReviews.nodes[] | {author: .author.login, state, submittedAt}],
    threads: [.reviewThreads.nodes[] | {id, isResolved, isOutdated, author: .comments.nodes[0].author.login}],
    commentTotal: .comments.totalCount
  }
`;

function fetchLive() {
    const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`, '--jq', JQ], {
        encoding: 'utf8',
    });
    const prs = out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    return { takenAt: new Date().toISOString(), prs };
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
    const vault = arg('vault', process.env.VAULT_ROOT || '');
    if (!vault) {
        console.error('Pass --vault <path> (the Obsidian vault root), or set VAULT_ROOT.');
        process.exit(1);
    }
    const dir = join(vault, 'Projects', 'dev-env', 'Journal');
    const path = join(dir, 'prs-snapshot.json');

    const prev = loadSnapshot(path);
    const curr = fetchLive();

    if (has('diff')) {
        if (!prev) {
            console.log('No previous snapshot — nothing to diff. This run establishes the baseline.');
        } else {
            printDiff(diffSnapshots(prev, curr));
        }
    }

    if (!has('dry-run')) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(curr, null, 2) + '\n');
        console.log(`wrote ${path}`);
    }
}

function cmdDiffFiles() {
    const [oldPath, newPath] = positional;
    if (!oldPath || !newPath) {
        console.error('Usage: prs-snapshot.mjs diff <old-snapshot.json> <new-snapshot.json>');
        process.exit(1);
    }
    const prev = JSON.parse(readFileSync(oldPath, 'utf8'));
    const curr = JSON.parse(readFileSync(newPath, 'utf8'));
    printDiff(diffSnapshots(prev, curr));
}

// ── dispatch ────────────────────────────────────────────────────────────────

if (cmd === 'diff') cmdDiffFiles();
else cmdSnapshot();

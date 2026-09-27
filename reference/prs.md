# PR tracking

Read this before answering any PR-status request, before writing the morning board's PR line, and
before touching a review comment. It is the single home for PR tracking — the morning board
(`greeting.md`), the end-of-day pass (`ledger.md#end-of-day`), and the Command Index all link here
instead of restating it.

## The query

One GraphQL call, `gh api graphql` has no `-c` flag, so formatting happens in `--jq`, not on the
`gh` command line. This is the query that ran today:

```bash
gh api graphql -f query='query { search(query: "is:pr is:open author:@me org:ORG", type: ISSUE, first: 50) { nodes { ... on PullRequest { number title isDraft url headRefName baseRefName updatedAt reviewDecision repository { nameWithOwner } reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } } } latestReviews(first: 10) { nodes { author { login } state submittedAt } } reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 1) { nodes { author { login } } } } } comments(last: 5) { totalCount nodes { author { login } createdAt } } } } } }' \
  --jq '
    .data.search.nodes[] |
    {
      repo: .repository.nameWithOwner,
      number, title, isDraft, url, headRefName, baseRefName, updatedAt,
      reviewDecision: (.reviewDecision // "NONE"),
      reviewers: [.reviewRequests.nodes[].requestedReviewer | (.login // .name) | select(. != null)],
      reviews: [.latestReviews.nodes[] | "\(.author.login):\(.state)"],
      unresolvedThreads: [.reviewThreads.nodes[] | select(.isResolved == false)],
      commentTotal: .comments.totalCount,
      recentComments: [.comments.nodes[] | "\(.author.login)@\(.createdAt[0:10])"]
    }
    | . + {
        unresolvedCount: (.unresolvedThreads | length),
        outdatedCount: ([.unresolvedThreads[] | select(.isOutdated)] | length),
        threadAuthors: ([.unresolvedThreads[].comments.nodes[0].author.login] | unique)
      }
    | [
        "\(.repo)#\(.number)",
        .title,
        (if .isDraft then "DRAFT" else "OPEN" end),
        "\(.headRefName)->\(.baseRefName)",
        .updatedAt,
        .reviewDecision,
        "reviewers=[\(.reviewers | join(","))]",
        "reviews=[\(.reviews | join(","))]",
        "unresolved=\(.unresolvedCount)(\(.threadAuthors | join(",")))\(if .outdatedCount > 0 then " [\(.outdatedCount) outdated]" else "" end)",
        "comments=\(.commentTotal) recent=[\(.recentComments | join(","))]",
        .url
      ]
    | @tsv
  '
```

Scoped to the ORG org on purpose — personal and third-party repos are out of scope for the board.

One line per PR, tab-separated: `repo#number`, title, draft/open, `head->base`, `updatedAt`,
`reviewDecision`, requested reviewers, latest review states, unresolved-thread count (with the
authors who opened them), comment total plus a few recent authors@dates, and the URL. Read the URL
column, don't reconstruct it — it's already correct for whatever host the repo is on.

**Unresolved counts everything, outdated is reported separately.** `unresolvedThreads` is every
thread with `isResolved == false`, outdated or not — a thread GitHub marked outdated because the
diff moved on is still unresolved and still needs someone to click Resolve. The unresolved count
in the TSV line is followed by `[N outdated]` only when that subset is non-empty, e.g.
`unresolved=5(alice,bob) [2 outdated]`. Don't reuse the old `openThreads` name (unresolved-and-not-
outdated) for anything — it undercounted what actually needs resolving.

`reviewRequests` distinguishes a `User` (a person) from a `Team` or a `Bot`. That distinction is
what separates "awaiting the team" from "nobody will pick this up" below — a Team or Bot request
alone does not mean a human is on the hook yet.

The query also carries `reviewThreads.nodes[].id` and `latestReviews.nodes[].submittedAt` — the
board's `--jq` ignores both, but [scripts/prs-snapshot.mjs](../scripts/prs-snapshot.mjs) needs them
as stable identity for its mid-day diff (see [Mid-day updates](#mid-day-updates)). Keep them in the
query even though the human-readable report doesn't print them.

## The buckets

Run every open PR through these, in order. A PR can only land in the first bucket it matches.

1. **Unresolved threads.** Count by author; note whether any thread author is a human reviewer
   (not a bot) and whether `reviewDecision` is `CHANGES_REQUESTED`. These are the ones that need
   the comment workflow below.
2. **Drafts waiting on the user.** `isDraft: true` with no open thread — the user's own draft,
   sitting until they finish or mark it ready.
3. **Awaiting the team.** Not draft, no unresolved threads, and at least one requested `User` (a
   person) still outstanding. A `Team` request riding along with it is fine, but a `Team` alone
   isn't enough to land here — see the anti-pattern below.
4. **Ready for review, no human reviewer requested.** Not draft, no request for a `User` — only a
   `Team`, only a `Bot`, some mix of the two, or nothing at all. Flag these explicitly: nobody is
   going to pick them up without a nudge.
5. **Approved and ready to merge.** `reviewDecision: APPROVED`, no unresolved threads.
6. **Changes requested, no open threads.** `reviewDecision: CHANGES_REQUESTED` but the threads that
   caused it are already resolved — usually means a re-review is overdue, not that work remains.
7. **Stale.** `updatedAt` more than 30 days ago. Nudge-or-close candidates — surface them, don't
   act without the user's word (see [Closing and branch deletion](#closing-and-branch-deletion)).

**Drift**, checked across all buckets, not its own bucket: a PR whose `baseRefName` doesn't match
the repo's documented flow (e.g. targets `main` directly instead of `develop`/`staging` — see
[reference/git.md](git.md)), or whose Jira status disagrees with what the PR is actually doing
(approved and mergeable while Jira still says *In Progress*, or a draft while Jira says *Code
Review*). Cross-reference the same way the [tracker review](ledger.md#end-of-day) does.

## Links are mandatory

Every PR is a clickable markdown link, `[repo#number](https://github.com/<owner>/<repo>/pull/<n>)`,
**every place it appears** — the morning board line, the full report, the end-of-day pass. No bare
`#438`, no bare repo/number pair. Link Jira keys the same way `greeting.md` already does:
`[KEY-123](https://<site>.atlassian.net/browse/KEY-123)`. A PR mentioned without its link is the
one anti-pattern this file exists to prevent — see [Anti-patterns](#anti-patterns).

## The comment workflow

For a PR with unresolved threads, the user may ask for a read-only agent per PR (one writer/reader
per PR — don't double up). That agent:

1. Drafts a per-thread verdict — `FIX` with a diff, `DECLINE`, `DEFER`, `ALREADY ADDRESSED`, or
   `QUESTION` — verified against the actual head code, not the diff as posted. Bot comments are
   judged on their merits, same as a human's.
2. Only drafts a comment for a thread that's still unaddressed **and** not auto-outdated. A thread
   already fixed by a commit, or one GitHub marked outdated, gets no comment — there's nothing left
   to say. For everything else, writes the draft to
   `$VAULT_ROOT/Projects/<repo>/Reviews/PR-<N>-comment-drafts.md`, and when presenting the batch for
   approval shows each as the link to the existing comment **plus** the draft response — never the
   response alone.

Nothing is pushed, resolved, or replied to until the user reviews the batch. On approval, a
write-agent applies the `FIX` verdicts as local commits in the repo's existing worktree for that
branch — one writer per branch/worktree, per
[reference/dispatch.md#concurrency-safety](dispatch.md#concurrency-safety). In a stack, only the
branch that owns the thread; never propagate a fix upward into a branch above it — that's a
rebase, and rebases need the user's say-so (see [reference/git.md](git.md)). If landing the batch
means rewriting commits already pushed, `--force-with-lease` on the branch is fine once the user
has approved that rewrite; protected branches (`main`, `staging`, `develop`, and any branch the
user didn't author) stay off limits regardless — full rule in [reference/git.md](git.md), not
restated here. Append an "Applied" section to the drafts file recording what landed.

By convention, a fixed comment gets no reply — the commit is the reply — and an auto-outdated one
gets no reply either; only `DECLINE` and `DEFER` get replies (step 2 above already excludes both
"no comment" cases). **Resolving the thread is a separate action from replying to it, and who does
it depends on who opened it.** Copilot and Aikido (bot) threads are ours to resolve — once the
finding lands, or once a declined bot thread has had its reply posted. A thread opened by a human
reviewer is never resolved by us, fixed or not — that reviewer resolves it; we only reply. Reply
text never mentions AI, agents, vault paths, or ledger ids — the team reading it has no way to
resolve those. Everything else about the git side of this — authorship, branch protection, commit
slicing — is [reference/git.md](git.md); don't restate it here.

## Mid-day updates

Between the morning board and end-of-day, only surface a watched PR if the change is actionable: a
human review landed, `reviewDecision` flipped, a human opened a new unresolved thread, a PR merged
or closed, or a draft got promoted to ready. A bot review, a bot thread, a CI status flip, or
routine activity waits for the next board — don't interrupt for it.

[scripts/prs-snapshot.mjs](../scripts/prs-snapshot.mjs) automates exactly this check. It runs the
query above via `gh api graphql`, and stores the result as JSON at
`$VAULT_ROOT/Projects/dev-env/Journal/prs-snapshot.json`:

```bash
node scripts/prs-snapshot.mjs --vault "$VAULT_ROOT"          # take the baseline (morning)
node scripts/prs-snapshot.mjs --diff --vault "$VAULT_ROOT"   # compare + report (mid-day, EOD)
```

Cadence: take a plain snapshot as part of the morning board
([greeting.md](greeting.md#a-greeting-is-a-request-for-the-board)), then run `--diff` at mid-day and
again during the [end-of-day PR pass](ledger.md#pr-pass) — each `--diff` run also overwrites the
snapshot, so it becomes the baseline for the next one. It prints only the actionable changes listed
above, one line each with the PR's link, and a single summary line for how many bot-only updates it
filtered out — never itemised, per the anti-pattern this section already guards against.

## Closing and branch deletion

Close a PR or delete its remote branch only on the user's explicit word, **per PR** — a batch
"clean these up" still means confirming each one, not inferring consent from the stale bucket.
Before deleting a remote branch:

1. Confirm it's the user's branch — the authorship check in [reference/git.md](git.md).
2. Confirm no open PR uses it as a base (a stacked PR pointing at it would be orphaned).

## Anti-patterns

- Listing a PR anywhere — board, report, or end-of-day — without its clickable link.
- Posting a review reply, resolving a thread, or pushing a commit the user hasn't approved in the
  batch.
- Treating a `Team` or `Bot` review request as "awaiting the team" when no human has actually been
  asked.
- Closing a PR or deleting a branch from the stale bucket without asking per PR.
- Surfacing a bot comment or CI flip mid-day instead of waiting for the next board.
- Propagating a comment fix upward through a stack without the user asking for the rebase.
- Resolving a thread a human reviewer opened instead of just replying to it — that's theirs to
  close, fixed or not.
- Posting a comment on a thread that's already fixed by a commit or already auto-outdated — neither
  needs one.

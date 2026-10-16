# Playbook: review a teammate's PR that has waited

Trigger: a `REVIEW-WAIT <PR key> <url> waiting <m> min, head <sha7>` line from `pr-watch` ([event-types/pr-watch.md](event-types/pr-watch.md)). Run it once per line. It never posts to GitHub: it ends with ONE review draft in the approval queue, and the user approves, edits or rejects it on the Podium's Others' PRs tab (README, "Drafted comments: approve, edit, reject").

Script: `node scripts/teammate-review.ts` (`prepare`, `firstpass`, `install`, `submit`, `cleanup`). Model: Haiku runs the commands; the review itself is one fresh Sonnet agent (Opus only when the diff touches auth, migrations or tenant scoping).

## Before prepare: the wait gate

`pr-watch` already enforces the base wait in code ([lib/teammate/wait.ts](../scripts/lib/teammate/wait.ts)): the PR is ready, someone else's, has no human review or decision yet, and has waited `teammate_review_minutes` (15) since it was opened or marked ready. The rest below is judgement the run applies by hand before `prepare`; none of it is enforced in `prepare` (it needs review-thread, mention and twin data that `REVIEW-WAIT` does not carry), so say in the report which rule you applied.

- Wait the 15 minutes from the latest of opened, marked ready, or re-requested. If a teammate reviewed in that window, draft only for a blocking issue.
- Skip a PR another teammate is clearly reviewing: they submitted a review on the current head, or have open review threads or comments from the last day. Exceptions: the user is requested or @-mentioned, or there is a blocking issue they have not raised.
- Step in anyway when the author has acted since that reviewer's last activity (a push, a reply or a re-request) and two working hours (default 120 minutes) have passed with no reviewer response.
- These skip the wait entirely: staging twins of a develop PR, backmerges, follow-ups to the user's PRs, PRs where the user is requested or @-mentioned, P0 or hotfix PRs, and re-reviews after the author addressed our comments.

## Steps

1. `prepare --repo <owner/name> --pr <n>` prints `{ path, head, base, author }`. It refuses the user's own PR, a draft, a closed PR and a self-review repo. The worktree is detached and read-only.
2. `firstpass --repo <owner/name> --pr <n> --path <path>` prints the PR body, what bots already said, the CI rollup and the test command of each changed package. Hand it to the reviewer as is.
3. `install --repo <owner/name> --pr <n> --path <path>` only when the reviewer needs to run the package's tests. It runs `npm ci --ignore-scripts` (the PR's install scripts never run, and only PATH, HOME and the npm config reach it, no tokens) with browser downloads skipped, and prints `git status`: if `dirty` lists files, say so; npm can flip mode bits on tracked files. If the tests need a build, run it by hand.
4. Dispatch the review agent with the brief below and, in the same message, `mithril-smells` in diff mode with `<path>` as its working directory. The reviewer's report is a JSON object, nothing else; the smells agent's report is read, not forwarded (see "The smells pass").
4a. Triage the PR's open bot threads (Copilot and other bots) from the first pass. For each important one (correctness, security, PHI, data loss, a deploy break), post one short reply in that thread saying it is important and the concrete consequence; bot-thread replies are pre-approved. Skip minor ones. Never resolve a thread. `submit` has no COMMENT event (it queues APPROVE or REQUEST_CHANGES only, see "Not enforced"), so when important bot threads are open do not queue an approving review: report them to the user and queue only a review that blocks.
5. Merge the two into one `report.json` and `submit < report.json` with `{ repo, pr, head, base, path, author, compliment, findings }` (`author` is the login `prepare` printed; the Podium's needs-you list names them). It applies the bar in code, anchors comments to lines in the diff and queues one review. Say what it dropped.
6. `cleanup --repo <owner/name> --path <path>`.

## The review agent's brief

- You are reviewing someone else's PR for the user, read-only. The worktree is at `<path>`; run the tests named in the first pass if they help.
- Read the diff, and also read the shared library code the PR relies on and compare with the sibling packages that do the same job. A change that is fine alone can differ from how its neighbours do it.
- Be lenient. BLOCK only for (1) a correctness bug with a concrete failure: the input and what goes wrong (wrong output, crash, data loss), (2) security: a secret or PHI/PII in code or logs, an auth or tenant-scoping hole, injection, (3) a deploy that cannot roll back: a destructive migration, a breaking API with no fallback. Everything else is a non-blocking suggestion, at most 3. Never block on naming, style, nice-to-have tests or refactors.
- Always check the diff for customer names and references that identify a client. Any hit is blocking (`security`, kind `customer-reference`).
- Open with one specific, genuine compliment that names the thing (for example, "the ID validation before anything goes into a URL"). Generic praise is refused.
- Write in the user's first person, friendly and polite. Never mention an assistant, a model or a tool.
- Report `{ "compliment": "...", "findings": [ { "category": "correctness|security|rollback|other", "kind": "...", "input": "...", "failure": "...", "path": "...", "line": N, "text": "..." } ] }`. `line` must be a line the PR changes, on the new side. `kind` is one of secret, phi-pii, auth, tenant-scope, injection, customer-reference (security) or destructive-migration, breaking-api-no-fallback (rollback).

## The smells pass

`mithril-smells` (Refactoring ch. 3, read-only) runs on every teammate PR that changes source files; skip it for a docs-only or config-only diff. Hand it the PR's diff and the worktree path, and tell it to report only. Then fold its output into `findings`:

- Each smell becomes `{ "source": "smell", "category": "other", "path": "...", "line": N, "cost": "...", "text": "..." }`. `cost` is the concrete maintenance cost the agent named (the next edit touches N places, or the bug a reader will plausibly write); a smell without one is not forwarded. `text` is the suggestion in the user's first person, naming the smell's catalog move ("could we pull this into a helper?"), friendly, never mentioning a tool.
- Leave out `[LINT]` lines (CI already runs the project's linter) and anything the reviewer reported on the same file within 3 lines. `submit` drops those duplicates itself, but do not rely on that.
- Smells never block and never change an APPROVE. `submit` enforces it: a `source: "smell"` finding is always a suggestion, whatever category or kind it claims, and it has its own cap of 2 so it cannot push out the reviewer's 3.

**Later rounds.** The smells pass runs on the first round of a PR only. On any review after our first one, keep only follow-ups on our earlier items and blocking findings in the new commits, and drop every new suggestion. `submit` enforces the smell half (a `source: "smell"` finding is dropped once another review of the PR is on record); keeping only follow-ups and blockers is on you.

A comment on a release PR about code already on main does not block: file a follow-up ticket instead.

## Not enforced in code

The wait-gate exceptions, the bot-thread triage and the COMMENT event for open important bot threads are described here only. Supporting a COMMENT review event means a third `ReviewEvent` through the queue, the Others' PRs tab and the post path, which is a separate change.

## What the user sees

When nothing blocks, an APPROVE review: the compliment, the suggestions inline on their lines, and a line saying the author can resolve them however they think best (fix now, follow up, or resolve if they disagree). When something blocks, a REQUEST_CHANGES review with the same shape. The user edits any of it first, or rejects it with a reason.

# Playbook: review a teammate's PR that has waited

Trigger: a `REVIEW-WAIT <PR key> <url> waiting <m> min, head <sha7>` line from `pr-watch` ([event-types/pr-watch.md](event-types/pr-watch.md)). Run it once per line. It never posts to GitHub: it ends with ONE review draft in the approval queue, and the user approves, edits or rejects it on the Podium's Others' PRs tab (README, "Drafted comments: approve, edit, reject").

Script: `node scripts/teammate-review.ts` (`prepare`, `firstpass`, `ticket`, `install`, `submit`, `cleanup`). Model: Haiku runs the commands; the review itself is one fresh Sonnet agent (Opus only when the diff touches auth, migrations or tenant scoping).

## Before prepare: the wait gate

`pr-watch` already enforces the base wait in code ([lib/teammate/wait.ts](../scripts/lib/teammate/wait.ts)): the PR is ready, someone else's, has no human review or decision yet, and has waited `teammate_review_minutes` (15) since it was opened or marked ready. The rest below is judgement the run applies by hand before `prepare`; none of it is enforced in `prepare` (it needs review-thread, mention and twin data that `REVIEW-WAIT` does not carry), so say in the report which rule you applied.

- Wait the 15 minutes from the latest of opened, marked ready, or re-requested. If a teammate reviewed in that window, draft only for a blocking issue.
- Skip a PR another teammate is clearly reviewing: they submitted a review on the current head, or have open review threads or comments from the last day. Exceptions: the user is requested or @-mentioned, or there is a blocking issue they have not raised.
- Step in anyway when the author has acted since that reviewer's last activity (a push, a reply or a re-request) and two working hours (default 120 minutes) have passed with no reviewer response.
- These skip the wait entirely: staging twins of a develop PR, backmerges, follow-ups to the user's PRs, PRs where the user is requested or @-mentioned, P0 or hotfix PRs, and re-reviews after the author addressed our comments.


**A settled PR is not reviewed, and its draft retires itself.** The Others' PRs tab drops a PR that is merged, closed, approved at its current head, or already reviewed by another person (unless you were explicitly requested and have not reviewed; it returns when the author pushes after that review and a reviewer is requested again), and the page rebuild rejects any pending review draft on such a PR with `Settled automatically: <why>; this review is not posted.` (rule and code: [lib/teammate/settled.ts](../scripts/lib/teammate/settled.ts), [lib/drafts/settle.ts](../scripts/lib/drafts/settle.ts)). If a PR is settled by the time you reach `submit`, expect that outcome and do not re-queue; the draft is kept with its reason, never deleted.
## Steps

1. `prepare --repo <owner/name> --pr <n>` prints `{ path, head, base, author }`. It refuses the user's own PR, a draft, a closed PR and a self-review repo. The worktree is detached and read-only.
2. `firstpass --repo <owner/name> --pr <n> --path <path>` prints the PR body, what bots already said, the CI rollup and the test command of each changed package. Hand it to the reviewer as is.
2a. **Ticket check, before the diff is read in depth.** `ticket --repo <owner/name> --pr <n>` finds the Jira key in the PR's title, branch and body (in that order) and reads the ticket with one read-only GET: `{ keys, ticket: { status: read | unreadable | none, summary, description, ... } }`. It needs `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment (run it under `with-env` where they live; `env-where JIRA` lists names, never values; never print them). When the script says `unreadable`, try the Atlassian MCP's issue read if it is connected; if neither works, the ticket match is `unreadable` and the draft says so. Never write to Jira, and never guess what a ticket says. Hand the ticket text to the reviewer with the first pass.
3. `install --repo <owner/name> --pr <n> --path <path>` only when the reviewer needs to run the package's tests. It runs `npm ci --ignore-scripts` (the PR's install scripts never run, and only PATH, HOME and the npm config reach it, no tokens) with browser downloads skipped, and prints `git status`: if `dirty` lists files, say so; npm can flip mode bits on tracked files. If the tests need a build, run it by hand.
4. Dispatch the review agent with the brief below and, in the same message, `mithril-smells` in diff mode with `<path>` as its working directory. The reviewer's report is a JSON object, nothing else; the smells agent's report is read, not forwarded (see "The smells pass").
4a. **Triage the PR's open bot threads (Copilot, Aikido, any bot), and point out the ones worth the author's time.** `threads --repo <owner/name> --pr <n>` prints each unresolved bot thread as `{ id, path, line, author, url, text }`. For every one, decide whether it is worth addressing (a real correctness, security, PHI, data-loss or deploy problem, or a clear improvement; not a nit or drift) and write one line why. Put the decisions in the report's `triage` list: `{ "threadId": "<id>", "worthAddressing": true|false, "reason": "<one line>", "severity": "blocking" }`, with `severity: "blocking"` only for a thread that is a correctness bug, a security issue, PHI exposure, data loss or a deploy break (that thread makes the approval post as a COMMENT review). Threads that are worth addressing are listed in the review body under "Worth addressing before merge" (a link to each and your reason); threads that are not worth it are not mentioned. An approval stands when threads are worth addressing: we point them out, we do not block. For an important one you may also post one short reply in that thread (bot-thread replies are pre-approved); never resolve a thread. Re-run `threads` just before `submit`: a thread that opens after you counted refuses the submit and is named, and you triage it.
5. Merge the two into one `report.json` and `submit < report.json` with `{ repo, pr, head, base, path, author, compliment, context, findings, triage }` (`author` is the login `prepare` printed; the Podium's needs-you list names them). It applies the bar in code, anchors comments to lines in the diff and queues one review. `submit` refuses a draft with no context, a part that is neither given nor marked not-checked, a verdict without a read ticket, or a core logic range that is not on lines the PR changes. Say what it dropped. For an approving draft it also runs the approve guard against GitHub now: a head that moved since `head`, or an open bot thread with no `triage` entry, is not queued and the message names it (triage the thread, or re-review the new head, and submit again; for the same head add `supersedes` with the pending draft's id, or the new triage is dropped as a duplicate); the output's `approvalAs` says `COMMENT` when a thread you triaged blocking will make the approval post as a comment. To replace a pending draft of the same head with a fuller one (a re-review under new rules), add `"supersedes": "<draft id>"`: the old draft is rejected with the reason on record and only the new one shows.
6. `cleanup --repo <owner/name> --path <path>`.

## Review summary

Every teammate review, and every relay of one to the user (the report, the Needs-you row, the Others' PRs card), uses this shape: six parts, in this order, none left out. A part with nothing to give says so ("not checked: <why>", "None.") instead of disappearing. `submit` enforces it: the context is required, each part is given or explicitly not checked, and the draft stores it as fields so the Podium renders it above Approve.

1. **What it does.** 2 to 4 plain lines on the PR's behaviour, from the diff, not the title.
2. **Core logic.** 1 to 5 permalinks at the head sha, `https://github.com/<owner>/<repo>/blob/<headSha>/<path>#L<a>-L<b>`, each with a short label. Only places where behaviour changes, never tests or config.
3. **Tests.** How many tests the PR adds or changes, what was run and its result, and what is only mocked or checked by hand. Or "not checked: <why>".
4. **Ticket match.** The Jira key and a verdict (does what it says, partly, does something else) with what is missing and what is extra; or plainly "no Jira key found" or "could not read it from Jira". Never guessed.
5. **Suggestions.** Numbered, one line each, blocking ones first and marked; non-blocking otherwise. "None." when there are none.
6. **Compliment.** One specific thing done well.

Worked example (fictional repo and ticket):

> **What it does**
> Adds a delivery history list to the shelf detail page of the Lantern Works catalogue app. Each row shows the carrier name and the date, newest first, and an empty shelf shows "No deliveries yet".
>
> **Core logic**
> - [Query joins carrier onto deliveries](https://github.com/lantern-works/catalogue/blob/0123456789abcdef0123456789abcdef01234567/src/shelves/history.ts#L40-L58) (`src/shelves/history.ts#L40-L58`)
> - [Empty state](https://github.com/lantern-works/catalogue/blob/0123456789abcdef0123456789abcdef01234567/web/ShelfDetail.tsx#L112-L118) (`web/ShelfDetail.tsx#L112-L118`)
>
> **Tests:** 5 tests added or changed. Ran: `npm test` in `src/shelves`, 5 passing. Only mocked or checked by hand: the carrier lookup is mocked; the empty state was not exercised.
>
> **Ticket match (LAN-212):** partly matches.
> Missing from the PR:
> - Pagination past 50 deliveries
> Nothing extra beyond the ticket.
>
> **Suggestions**
> 1. Non-blocking, `src/shelves/history.ts:52`: the join can drop a shelf's last row when the inner limit applies first; could we limit after the join?
>
> The ordering test that pins newest-first with two deliveries on the same day is a careful touch.

## The review agent's brief

- You are reviewing someone else's PR for the user, read-only. The worktree is at `<path>`; run the tests named in the first pass if they help.
- Start with the ticket (summary, description, acceptance criteria) and the PR's own description, before the diff. Then read the diff against them and decide the verdict: `does what it says`, `partly` or `does something else`. List what the ticket asks for that the diff does not do (`missing`) and what the diff does that the ticket never asked for (`extra`). Tests and config are not "extra" on their own. With no key found, or a ticket you could not read, the status is `none` or `unreadable` and there is no verdict: say so, do not infer the intent from the PR.
- Read the diff, and also read the shared library code the PR relies on and compare with the sibling packages that do the same job. A change that is fine alone can differ from how its neighbours do it.
- Be lenient. BLOCK only for (1) a correctness bug with a concrete failure: the input and what goes wrong (wrong output, crash, data loss), (2) security: a secret or PHI/PII in code or logs, an auth or tenant-scoping hole, injection, (3) a deploy that cannot roll back: a destructive migration, a breaking API with no fallback. Everything else is a non-blocking suggestion, at most 3. Never block on naming, style, nice-to-have tests or refactors.
- Always check the diff for customer names and references that identify a client. Any hit is blocking (`security`, kind `customer-reference`).
- Open with one specific, genuine compliment that names the thing (for example, "the ID validation before anything goes into a URL"). Generic praise is refused.
- Write in the user's first person, friendly and polite. Never mention an assistant, a model or a tool.
- Also report the summary's context (see "Review summary"): `"context": { "summary": "2-4 plain lines on what the PR does", "core": [ { "path": "...", "start": N, "end": M, "label": "short link text" } ], "tests": { "status": "reported", "count": N, "ran": "what was run and the result", "gaps": ["only mocked or manual"] }, "ticket": { "status": "read|none|unreadable", "key": "WID-1234", "verdict": "does what it says|partly|does something else", "missing": [], "extra": [], "reason": "..." } }`. `core` is 1 to 5 places where behaviour actually changes, never tests or config; `start` and `end` are lines on the new side that the PR changes. `tests` is `{ "status": "not-checked", "reason": "..." }` when they were not looked at. `ticket.key` is required unless status is `none`; `verdict` only when status is `read`; `reason` says why an unreadable ticket could not be read, with no secret in it.
- Report `{ "compliment": "...", "context": { ... }, "findings": [ { "category": "correctness|security|rollback|other", "kind": "...", "input": "...", "failure": "...", "path": "...", "line": N, "text": "..." } ] }`. `line` must be a line the PR changes, on the new side. `kind` is one of secret, phi-pii, auth, tenant-scope, injection, customer-reference (security) or destructive-migration, breaking-api-no-fallback (rollback).

## The smells pass

`mithril-smells` (Refactoring ch. 3, read-only) runs on every teammate PR that changes source files; skip it for a docs-only or config-only diff. Hand it the PR's diff and the worktree path, and tell it to report only. Then fold its output into `findings`:

- Each smell becomes `{ "source": "smell", "category": "other", "path": "...", "line": N, "cost": "...", "text": "..." }`. `cost` is the concrete maintenance cost the agent named (the next edit touches N places, or the bug a reader will plausibly write); a smell without one is not forwarded. `text` is the suggestion in the user's first person, naming the smell's catalog move ("could we pull this into a helper?"), friendly, never mentioning a tool.
- Leave out `[LINT]` lines (CI already runs the project's linter) and anything the reviewer reported on the same file within 3 lines. `submit` drops those duplicates itself, but do not rely on that.
- Smells never block and never change an APPROVE. `submit` enforces it: a `source: "smell"` finding is always a suggestion, whatever category or kind it claims, and it has its own cap of 2 so it cannot push out the reviewer's 3.

**Later rounds.** The smells pass runs on the first round of a PR only. On any review after our first one, keep only follow-ups on our earlier items and blocking findings in the new commits, and drop every new suggestion. `submit` enforces the smell half (a `source: "smell"` finding is dropped once another review of the PR is on record); keeping only follow-ups and blockers is on you.

A comment on a release PR about code already on main does not block: file a follow-up ticket instead.

## Enforced at approve time

Whoever posts an approval runs the same guard (`lib/approve-guard.ts`): `submit` while queueing, the Podium's Approve when the user clicks, and `scripts/approve-pr.ts` for a manual approval. It reads GitHub live and refuses when the head is not the reviewed commit, or when an open bot thread has no triage entry; it posts COMMENT instead of APPROVE when a thread was triaged blocking. It exists because an approval went out on dtr#4072 while a Copilot thread that landed after the review agent counted was open. Never approve with a raw `gh pr review --approve` or `gh api .../reviews`: use `node scripts/approve-pr.ts --repo <owner/name> --pr <n> --head <reviewed sha> --body-file <file> [--triage-file <file>]`, which runs the guard and refuses with the threads listed.

## Not enforced in code

The wait-gate exceptions and the judgement behind each triage entry (is a thread worth addressing, is it blocking) are described here only; the code checks that every open bot thread has an entry and acts on the entry, not on whether it is right.

## What the user sees

Every draft, approvals too, carries the six-part summary (see "Review summary"): the Podium card shows it above Approve with the core logic links clickable, and the posted review body carries the same parts. When nothing blocks, an APPROVE review: that summary, the suggestions inline on their lines, and a line saying the author can resolve them however they think best (fix now, follow up, or resolve if they disagree). When something blocks, a REQUEST_CHANGES review with the same shape. The user edits any of it first, or rejects it with a reason.

# Playbook: review a teammate's PR that has waited

Trigger: a `REVIEW-WAIT <PR key> <url> waiting <m> min, head <sha7>` line from `pr-watch` ([event-types/pr-watch.md](event-types/pr-watch.md)). Run it once per line. It never posts to GitHub: it ends with ONE review draft in the approval queue, and the user approves, edits or rejects it on the Podium's Others' PRs tab (README, "Drafted comments: approve, edit, reject").

Script: `node scripts/teammate-review.ts` (`prepare`, `firstpass`, `install`, `submit`, `cleanup`). Model: Haiku runs the commands; the review itself is one fresh Sonnet agent (Opus only when the diff touches auth, migrations or tenant scoping).

## Steps

1. `prepare --repo <owner/name> --pr <n>` prints `{ path, head, base, author }`. It refuses the user's own PR, a draft, a closed PR and a self-review repo. The worktree is detached and read-only.
2. `firstpass --repo <owner/name> --pr <n> --path <path>` prints the PR body, what bots already said, the CI rollup and the test command of each changed package. Hand it to the reviewer as is.
3. `install --repo <owner/name> --pr <n> --path <path>` only when the reviewer needs to run the package's tests. It runs `npm ci --ignore-scripts` (the PR's install scripts never run, and only PATH, HOME and the npm config reach it, no tokens) with browser downloads skipped, and prints `git status`: if `dirty` lists files, say so; npm can flip mode bits on tracked files. If the tests need a build, run it by hand.
4. Dispatch one review agent with the brief below. Its report is a JSON object, nothing else.
5. `submit < report.json` with `{ repo, pr, head, base, path, author, compliment, findings }` (`author` is the login `prepare` printed; the Podium's needs-you list names them). It applies the bar in code, anchors comments to lines in the diff and queues one review. Say what it dropped.
6. `cleanup --repo <owner/name> --path <path>`.

## The review agent's brief

- You are reviewing someone else's PR for the user, read-only. The worktree is at `<path>`; run the tests named in the first pass if they help.
- Read the diff, and also read the shared library code the PR relies on and compare with the sibling packages that do the same job. A change that is fine alone can differ from how its neighbours do it.
- Be lenient. BLOCK only for (1) a correctness bug with a concrete failure: the input and what goes wrong (wrong output, crash, data loss), (2) security: a secret or PHI/PII in code or logs, an auth or tenant-scoping hole, injection, (3) a deploy that cannot roll back: a destructive migration, a breaking API with no fallback. Everything else is a non-blocking suggestion, at most 3. Never block on naming, style, nice-to-have tests or refactors.
- Always check the diff for customer names and references that identify a client. Any hit is blocking (`security`, kind `customer-reference`).
- Open with one specific, genuine compliment that names the thing (for example, "the ID validation before anything goes into a URL"). Generic praise is refused.
- Write in the user's first person, friendly and polite. Never mention an assistant, a model or a tool.
- Report `{ "compliment": "...", "findings": [ { "category": "correctness|security|rollback|other", "kind": "...", "input": "...", "failure": "...", "path": "...", "line": N, "text": "..." } ] }`. `line` must be a line the PR changes, on the new side. `kind` is one of secret, phi-pii, auth, tenant-scope, injection, customer-reference (security) or destructive-migration, breaking-api-no-fallback (rollback).

## What the user sees

When nothing blocks, an APPROVE review: the compliment, the suggestions inline on their lines, and a line saying the author can resolve them however they think best (fix now, follow up, or resolve if they disagree). When something blocks, a REQUEST_CHANGES review with the same shape. The user edits any of it first, or rejects it with a reason.

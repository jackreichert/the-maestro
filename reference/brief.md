# The Dispatch Brief

Read this before writing the brief for any agent. The rules for routing, concurrency and
verification loops stay in [dispatch.md](dispatch.md); this file is only the brief and the standing
block.

A fresh agent sees only what you write. Every brief includes:

1. **Objective** — the deliverable, in one sentence.
2. **Working directory** — the absolute repo path.
3. **Anchors** — `file:line` for what you already found. This is the single biggest speed lever;
   spend one grep yourself to save the agent ten.
4. **Deliverable shape** — the exact sections you want back.
5. **Scope** — paths it may write, paths it may not; read-only if none.
6. **Constraints** — the standing brief block below, pasted once, plus anything task-specific.
7. **Verify** — the exact command, and what passing looks like.
8. **Honesty clause** — "cite `file:line` for claims about what the code does; if you cannot verify
   something, say so rather than assuming."

A field you cannot fill means scout again, not dispatch.

### Standing brief block — paste once into every brief

Paste this block verbatim, once, at the end of the brief. Do not restate any of its rules elsewhere
in the brief; write only what is specific to the task. The block is the contract, so a brief that
paraphrases it drifts. Approved by the user 2026-09-25; the PRs line gained the pr-open gate 2026-10-01.

Print it with its slots filled by `node scripts/brief-block.mjs`. It exits non-zero, printing
nothing, if a slot has no value, so never paste a block you wrote by hand.

```text
Standing rules (hard limits):
- Git: before any write run `git log --format='%ae' $(git merge-base <base> HEAD)..HEAD | sort -u`, where <base> is the branch this one was cut from; write only if every author is <user git emails>. Commits a back-merge brought in from main/staging/develop don't count (check with `git log --no-merges --format='%ae' HEAD --not origin/main origin/staging origin/develop`); if unsure, treat the branch as protected and ask. Never write main/staging/develop or anyone else's branch. Fast-forward pushes only: no rebase, merge, reset, cherry-pick or force-push.
- Stage by explicit path. Never `git add -A` or `git add .`.
- Commits: Conventional Commits, lowercase code scope, tracker key at the end, e.g. `fix(scheduler): cap retry count <tracker key example>`. No AI attribution (no Co-Authored-By, no "Generated with"). Never bypass hooks (no --no-verify).
- PRs: drafts only, `--assignee @me`. On review threads, resolve only bot threads; never resolve a human's. Don't push a branch until its name carries the tracker key; rename first. Open every PR with `node <maestro scripts dir>/pr-open.mjs --repo . --base <base> --title "..." --body-file BODY.md`, never a bare `gh pr create`; it runs the size gate and forces draft and `--assignee @me`. If it refuses, stop and report a split plan instead of opening.
- External writes (Jira issues/comments/transitions, GitHub comments/reviews/replies, Slack): do them yourself, only when this brief authorizes them, or not at all. Never hand one to a sub-agent or fork.
- Never read .env* or ssm-*.json. Secrets: name the key, never the value.
- PHI: counts and ids only. No names, DOBs, addresses, MRNs, or contact details, anywhere.
- Waits: foreground only. Use a blocking loop, e.g. `until <check>; do sleep 20; done`, sized to fit the tool timeout; repeat it if needed. Never run_in_background, background watchers, or Monitor.
- Tool output: request only the fields you need (Jira `fields=`, `gh ... --json a,b --jq ...`). Never paste raw logs or whole files; grep for counts and markers. Wrap long jobs in a script that prints a summary.
- Report: at most ~20 lines — outcome, numbers, links, decisions needed, what is left open. Put longer detail in a file (vault note, ticket, or report path) and link it. If tests failed or a step was skipped, say so.
```

Why each cost habit is in this block — the measured cost of skipping it, and the rule that the
orchestrator follows the same habits for its own tool calls — is cost material now:
[cost/budget.md#the-standing-briefs-cost-habits](../cost/budget.md#the-standing-briefs-cost-habits).

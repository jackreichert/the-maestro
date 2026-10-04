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
paraphrases it drifts. Approved by the user 2026-09-25; PRs line updated 2026-10-01 (pr-open gate), approved by the user. Waits line updated 2026-10-02 (no output-file polling, foreground tests under a timeout); the user should confirm it.

Print it with its slots filled by `node scripts/brief-block.ts`. It exits non-zero, printing
nothing, if a slot has no value, so never paste a block you wrote by hand.

```text
Standing rules (hard limits):
- Git: before any write run `git log --format='%ae' $(git merge-base <base> HEAD)..HEAD | sort -u`, where <base> is the branch this one was cut from; write only if every author is <user git emails>. Commits a back-merge brought in from main/staging/develop don't count (check with `git log --no-merges --format='%ae' HEAD --not origin/main origin/staging origin/develop`); if unsure, treat the branch as protected and ask. Never write main/staging/develop or anyone else's branch. Fast-forward pushes only: no rebase, merge, reset, cherry-pick or force-push.
- Stage by explicit path. Never `git add -A` or `git add .`.
- Commits: Conventional Commits, lowercase code scope, tracker key at the end, e.g. `fix(scheduler): cap retry count <tracker key example>`. No AI attribution (no Co-Authored-By, no "Generated with"). Never bypass hooks (no --no-verify).
- PRs: drafts only, `--assignee @me`. On review threads, resolve only bot threads; never resolve a human's. Don't push a branch until its name carries the tracker key; rename first. Open every PR with `node <maestro scripts dir>/pr-open.ts --repo . --base <base> --title "..." --body-file BODY.md`, never a bare `gh pr create`; it runs the size gate and forces draft and `--assignee @me`. If it refuses, stop and report a split plan instead of opening.
- External writes (Jira issues/comments/transitions, GitHub comments/reviews/replies, Slack): do them yourself, only when this brief authorizes them, or not at all. Never hand one to a sub-agent or fork.
- Never read .env* or ssm-*.json. Secrets: name the key, never the value.
- PHI: counts and ids only. No names, DOBs, addresses, MRNs, or contact details, anywhere.
- Waits: foreground only. Never run_in_background, background watchers, or Monitor, and never poll an output file in an until/sleep loop (that is how an agent hangs). Run tests in the foreground under a hard timeout (e.g. `timeout 600 npm test`); if one hangs, stop and report which test, do not wait it out. To wait on an outside condition, use one blocking check sized to fit the tool timeout.
- Tool output: request only the fields you need (Jira `fields=`, `gh ... --json a,b --jq ...`). Never paste raw logs or whole files; grep for counts and markers. Wrap long jobs in a script that prints a summary.
- Report: at most ~20 lines — outcome, numbers, links, decisions needed, what is left open. Put longer detail in a file (vault note, ticket, or report path) and link it. If tests failed or a step was skipped, say so.
```

### Scripts shelf line — appended when `scripts_dir` is set

`brief-block.ts` appends this line after the standing block when the install sets `scripts_dir` ([local-config](local-config.md)), with `<scripts_dir>` filled. With `scripts_dir` unset nothing is appended.

```text
- Scripts: before writing a script, check <scripts_dir>/README.md for an existing helper. Put one-offs in <scripts_dir>/scratch/ (never /tmp) with a 3-line header: purpose; date + ledger id; inputs as env var names. No secrets and no outputs in that folder. Prod-check scripts take identifiers (locations, jobs, sensors) from a known-good sibling script or the real UI or URL, never from assumption; when a lookup matches nothing they print what does exist and exit non-zero; a fixture you wrote yourself does not validate names.
```

### Agent-owned repos line — appended when `agent_owned_repos` is set

`brief-block.ts` appends this line when the install lists `agent_owned_repos` ([local-config](local-config.md)), with `<agent_owned_repos>` filled. It is the only exception to the protected-branch stop, and only for the listed paths. With the setting empty nothing is appended.

```text
- Agent-owned repos (<agent_owned_repos>): the protected-branch stop does not apply in these repos only; you may commit directly to the default branch there. Conventional Commits, staging by explicit path and no AI attribution still apply, and so do the no rebase, reset and force-push rules.
```

Why each cost habit is in this block — the measured cost of skipping it, and the rule that the
orchestrator follows the same habits for its own tool calls — is cost material now:
[cost/budget.md#the-standing-briefs-cost-habits](../cost/budget.md#the-standing-briefs-cost-habits).

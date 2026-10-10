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

**Before a build brief:** name the nearest existing mechanism (config, flag, helper, earlier PR) and why it is not enough, and put that answer in the brief as the builder's starting point. If it is enough, dispatch a config or doc change, or nothing.

### The brief file — `journal.ts brief <id>`

For a ledger item, `node scripts/journal.ts brief <id> --model ... --used ...` writes this whole brief as a file, so the dispatch prompt is one line and nothing in the standing block is retyped. The file holds the item's text, the repo and working directory, the library pages for the task (from `library-brief.ts` when it is installed; a lookup that fails or hangs puts an "unavailable" line in the brief and the brief still goes out, and a missing script is stated in the file), your task details (`--details-file`: anchors, scope, verify command), the hand-back cap and report path, and the standing block. The same run promotes a queued item, records a `brief` row with both paths, and takes the repo claim for the item's stream (`--read-only` takes none and writes its own `-ro` files, apart from the writer's). A claim you already took with `claim` for the same desk is kept. If another desk has the repo, or another holder (`--as`, default the desk) already briefed this item, it exits 1 naming them and writes nothing; stop and report, do not release their claim. Rerunning as the same holder reuses the file and writes only the rows a partial run left out; a second writer brief on a repo that already has one is refused, and a grant left by a dead run is reclaimed. `release <repo>` ends the item grants, even when the repo claim was never taken. It prints the Agent prompt to use. The fields above still apply: put them in the details file.

### Standing brief block — paste once into every brief

Paste this block verbatim, once, at the end of the brief. Do not restate any of its rules elsewhere
in the brief; write only what is specific to the task. The block is the contract, so a brief that
paraphrases it drifts. Approved by the user 2026-09-25; PRs line updated 2026-10-01 (pr-open gate), approved by the user. PR text line added 2026-10-07; Report line changed to a file plus a headline 2026-10-07; the user should confirm both. Waits line updated 2026-10-02 (no output-file polling, foreground tests under a timeout); the user should confirm it. Learned line added 2026-10-08 (ledger-to-library slice L1); the user should confirm it. Necessity line added 2026-10-09 at the user's request.

Print it with its slots filled by `node scripts/brief-block.ts`. It exits non-zero, printing
nothing, if a slot has no value, so never paste a block you wrote by hand.

```text
Standing rules (hard limits):
- Git: before any write run `git log --format='%ae' $(git merge-base <base> HEAD)..HEAD | sort -u`, where <base> is the branch this one was cut from; write only if every author is <user git emails>. Commits a back-merge brought in from main/staging/develop don't count (check with `git log --no-merges --format='%ae' HEAD --not origin/main origin/staging origin/develop`); if unsure, treat the branch as protected and ask. Never write main/staging/develop or anyone else's branch. Fast-forward pushes only: no rebase, merge, reset, cherry-pick or force-push.
- Stage by explicit path. Never `git add -A` or `git add .`.
- Commits: Conventional Commits, lowercase code scope, tracker key at the end, e.g. `fix(scheduler): cap retry count <tracker key example>`. No AI attribution (no Co-Authored-By, no "Generated with"). Never bypass hooks (no --no-verify).
- PRs: drafts only, `--assignee @me`. On review threads, resolve only bot threads; never resolve a human's. Never be the reviewer of your own fix: after you push fixes for bot threads, report the head sha and stop; a fresh agent re-reviews it before the PR counts as ready. Don't push a branch until its name carries the tracker key; rename first. Open every PR with `node <maestro scripts dir>/pr-open.ts --repo . --base <base> --title "..." --body-file BODY.md`, never a bare `gh pr create`; it runs the size gate and forces draft and `--assignee @me`. If it refuses, stop and report a split plan instead of opening.
- PR state: before you push to a PR branch, run `node <maestro scripts dir>/pr-state.ts OWNER/REPO#N`; if it prints a PUSH WARNING (approvals on the current head that the push will dismiss), put that line in your report. Run it again before saying a PR is ready: say ready for review only when `READY-FOR-REVIEW:` says yes, and mergeable only when `READY-TO-MERGE:` says yes.
- PR text (title, body, comments): write as the author in the first person, never as an assistant, and never mention an assistant, agent, ledger, vault or any private id; use PR numbers, tracker keys, SHAs and plain words. The body needs Context, Reviewer guide, Risk and blast radius, Rollback / flag and How to verify locally sections, `{{file:path}}` links to the files it points at (add a line anchor such as `{{file:path#R42-R50}}` to land on the changed lines; `node <maestro scripts dir>/pr-guide-links.ts --hunks . PR_NUMBER` lists the ranges worth linking), and a small mermaid diagram when it helps. Do not write commit, file or line counts (or a running test tally) into it, since the page shows them and a push makes them stale: say what each commit or file group does, and which command ran against which commit. The full list is in git.md. No AI attribution.
- External writes (Jira issues/comments/transitions, GitHub comments/reviews/replies, Slack): do them yourself, only when this brief authorizes them, or not at all. Never hand one to a sub-agent or fork.
- Never read .env* or ssm-*.json. Secrets: name the key, never the value.
- Secret-bearing files (env files, infrastructure variable files that hold keys, Terraform state and plan JSON, secrets-manager exports, connection strings): never print, cat, or grep with context. Read only the exact keys you need, names-only (list variable names, not values). Recursive greps over infrastructure repos must exclude these files. On an infrastructure review, read the PR diff stat and the named hunks, not the whole variable file. If a secret is printed anyway, say so in one line in the report without repeating it.
- Missing credential: before reporting a secret as missing or blocked, look it up by name by running `env-where` with the variable name, which prints where it lives and never a value. Only if that finds nothing, report it as missing. Never open the file it names to check.
- Env store: environment files live outside every worktree, in the env store (`env_store_root`, default ~/dev-env/.env-store) as REPO/PROJECT/ plus REPO/shared/ for repo-wide values. A worktree holds symlinks to its own project's files and shared, never another project's. A real env file found in a worktree is moved in by running `env-store-move` with the worktree, the file name and the project; never open it.
- PHI: counts and ids only. No names, DOBs, addresses, MRNs, or contact details, anywhere.
- Waits: foreground only. Never run_in_background, background watchers, or Monitor, and never poll an output file in an until/sleep loop (that is how an agent hangs). Run tests in the foreground under a hard timeout (e.g. `timeout 600 npm test`); if one hangs, stop and report which test, do not wait it out. To wait on an outside condition, use one blocking check sized to fit the tool timeout.
- Docs: a vault note you write for a ticket gets `ticket.mjs attach TICKET NOTE --kind KIND` before you report, or `ticket: none` in its frontmatter when it belongs to no ticket; an outside document gets `attach --url`. If your work changed an epic's state (closed or reopened a child, recorded a decision, found a risk), run `ticket.mjs brief EPIC --refresh` and rewrite its Status paragraph before you report.
- Tool output: request only the fields you need (Jira `fields=`, `gh ... --json a,b --jq ...`). Never paste raw logs or whole files; grep for counts and markers. Wrap long jobs in a script that prints a summary.
- Necessity: before building, answer in the report: do we need this? Does something already exist (config, flag, helper, framework hook, an earlier PR) that does it, or that a small refactor would make do it? Name the nearest existing mechanism and why it is not enough; if it is enough, stop and say so instead of building.
- Learned: end your report with one line per fact you established that a later agent would otherwise have to re-derive (how something works, a gotcha, how to do a recurring thing), in the form `Learned: claim | kind | applies-to | evidence | verified-at | confidence` (kind how-to, how-it-works, gotcha, decision or tool; applies-to repo:component[:env]; confidence observed, told-by-jack or inferred), or record it yourself with `node <maestro scripts dir>/journal.ts learned --help`. Systems, ids and counts only: evidence is a path, a PR or a command and its count, never a secret or PHI value; a value-shaped claim is refused. Leave out status and restated decisions.
- Report: write the full report to a file (a vault note or report path the brief names) and hand back only a headline paragraph, under 150 words, plus that file path: outcome, numbers, links, decisions needed, what is left open. If tests failed or a step was skipped, say so in the headline.
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

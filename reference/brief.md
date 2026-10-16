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

**Before a build brief:** name the nearest existing mechanism (config, flag, helper, earlier PR) and why it is not enough, and put that answer in the brief as the builder's starting point. That answer is the first line of the Prior art section of [the build plan](#the-build-plan), which the brief also carries. If it is enough, dispatch a config or doc change, or nothing.

A rule that is long and stands across many briefs (a policy, a checklist, a style guide) is not retyped into each brief: put it in a file, name the path in the brief and tell the agent to read it. The brief stays short and the file is edited once.

A builder's brief says to review locally before any push, and that a fix is checked by running it; a fresh agent, not the builder, re-reviews it ([reference/prs.md](prs.md#re-review-before-ready)). A reviewer's brief says to run targeted tests plus tsc only: the full suite is run by a script, not by the reviewer. Either a detached `suite-run.ts` job whose `results.json` the reviewer reads, or `suite-summary.ts`, which a script or Haiku step runs and whose compact output (counts, first failures, slowest tests, regressions against the baseline) the reviewer reads or is handed. The reviewer's own runs are targeted probes (edge input, timing on a large input, the suspected failure), never a loop on the full suite. The first review may go to Opus; every re-review after it goes to Sonnet.

### The review brief

A reviewer's brief carries four rules that the "concrete failure only" filter would otherwise drop.

- **Naming pass.** The reviewer reads the name of every function, variable, type, file and flag in every touched file, scripts, fixtures and one-offs included, and flags a name that misleads or does not say what the thing is. In team repos a reader's trouble with a name is a finding, not a nitpick, so a "no nitpicks" loop never filters it out. The result goes in the review note's `## Naming pass` section.
- **Customer names and references.** Always check the diff for customer names, org names, people's names, or references that identify a client; any hit is a blocking finding. This is mandatory in every review, whatever else the brief narrows, and it is a read, not only the machine check: the [leak gate](git.md#leak-gate) catches the configured terms and the built-in shapes, but a client named by a nickname, a site, a product or an id only a person recognises gets through it. The result goes in the review note's findings, as a line saying what was checked, even when nothing was found.
- **Skim-safe is for humans.** A Reviewer guide may tell the human reviewer which files to skim. That label never removes a file from our own review: every file in the diff gets the naming pass and the read.
- **Org checklist.** When `reviewer_checklist` names a file, the brief names that path, tells the reviewer to read it and to walk each item against the diff, and requires the review note's `## Reviewer checklist` section. The note and the push gate are in [git.md](git.md#review-note-gate).

### The build plan

A build brief (a writer brief) carries a plan in its details file, with three parts. `journal.ts brief` refuses a writer brief whose details lack any of them, writing nothing and taking no claim; the escape hatch is `--one-point`, below.

1. **Invariants.** What must be true when the work is done, derived from first principles (what the system has to guarantee), not from the diff you expect to write. Each one is checkable.
2. **Prior art.** What was read before deciding: in this repo, in sibling implementations (for example the other EMR adapters) and in core packages (for example `@arya/core`). One line per thing read, each ending in **reuse** or **why not**. "None" is not an answer: if nothing was read, go and read.
3. **Prep refactor.** `none`, or a preparatory refactor that lands as its own first commit or ticket. The line comes from running the `mithril-smells` agent read-only over the files the plan touches; the planner reads its output, not the smells or refactor skill texts, so those stay out of the planner's context.

```markdown
## Invariants
- <what must hold when done>

## Prior art
- <path or package read>: reuse | not reused, because <reason>

**Prep refactor:** none | <the refactor, landing as its own first commit or ticket>
```

**1-point, one-file changes skip all of this.** Pass `--one-point` instead; the brief records that it was declared, and the builder stops and says so if the work grows.

**Planning miss.** A review comment such as "core already has this helper" or "the other EMR does this differently" means the Prior art step failed: the plan did not read what it should have. Treat it as a miss in the plan, not only a fix to the code.

### The brief file — `journal.ts brief <id>`

For a ledger item, `node scripts/journal.ts brief <id> --model ... --used ...` writes this whole brief as a file, so the dispatch prompt is one line and nothing in the standing block is retyped. The file holds the item's text, the repo and working directory, the library pages for the task (from `library-brief.ts` when it is installed; a lookup that fails or hangs puts an "unavailable" line in the brief and the brief still goes out, and a missing script is stated in the file), your task details (`--details-file`: the [build plan](#the-build-plan), anchors, scope, verify command; a writer brief without the plan is refused unless `--one-point`), the hand-back cap and report path, and the standing block. The same run promotes a queued item, records a `brief` row with both paths, and takes the repo claim for the item's stream (`--read-only` takes none and writes its own `-ro` files, apart from the writer's). A claim you already took with `claim` for the same desk is kept. If another desk has the repo, or another holder (`--as`, default the desk) already briefed this item, it exits 1 naming them and writes nothing; stop and report, do not release their claim. Rerunning as the same holder reuses the file and writes only the rows a partial run left out; a second writer brief on a repo that already has one is refused, and a grant left by a dead run is reclaimed. `release <repo>` ends the item grants, even when the repo claim was never taken. `--done-when "<criteria>"` sets what must be true for the work to count as done; the file puts it before the library and the work, and without it asks the agent to write its own criteria first. The report section is the handoff contract: the report file states the done criteria and whether each was met, the agent's confidence and what it was measured on, what it tried that failed, and who owns the work if it stops part-way. It prints the Agent prompt to use. The fields above still apply: put them in the details file.

### Standing brief block — paste once into every brief

Paste this block verbatim, once, at the end of the brief. Do not restate any of its rules elsewhere
in the brief; write only what is specific to the task. The block is the contract, so a brief that
paraphrases it drifts.

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
- Sub-agents: dispatch none unless this brief says so; name the model explicitly on every call (an omitted one inherits the costliest).
- External writes (Jira issues/comments/transitions, GitHub comments/reviews/replies, Slack): do them yourself, only when this brief authorizes them, or not at all. Never hand one to a sub-agent or fork.
- Never read .env* or ssm-*.json. Secrets: name the key, never the value.
- Secret-bearing files (env files, infrastructure variable files that hold keys, Terraform state and plan JSON, secrets-manager exports, connection strings): never print, cat, or grep with context. Read only the exact keys you need, names-only (list variable names, not values). Recursive greps over infrastructure repos must exclude these files. On an infrastructure review, read the PR diff stat and the named hunks, not the whole variable file. If a secret is printed anyway, say so in one line in the report without repeating it.
- Missing credential: before reporting a secret as missing or blocked, look it up by name by running `env-where` with the variable name, which prints where it lives and never a value. Only if that finds nothing, report it as missing. Never open the file it names to check.
- Local database: to verify against the local Postgres, run `local-db --db NAME -c "SELECT ..."` (read-only by default as a guardrail; `--write` only when the brief allows a local write; never try to get around its refusals). It reads the URL itself, accepts only localhost, refuses the :5438 and :5439 proxy ports, and never prints the URL or password, so never source an env file or build a connection string. Ids, statuses and counts only, no PII columns. Prod and staging are not reachable this way.
- Env store: environment files live outside every worktree, in the env store (`env_store_root`, default ~/dev-env/.env-store) as REPO/PROJECT/ plus REPO/shared/ for repo-wide values. A worktree holds symlinks to its own project's files and shared, never another project's. A real env file found in a worktree is moved in by running `env-store-move` with the worktree, the file name and the project; never open it.
- Blocked on a command only the user can run (a tool call denied, a permission, a vault or settings write): register it instead of only pasting it in chat. Run `node <maestro scripts dir>/journal.ts script add --kind one-time` (or `reusable` for a tool worth running again) with `--title`, `--what`, `--why`, `--after`, `--blocks` (the ledger id of the blocked work) and `--blocked-by` (your task), then `--` and the command. Say in your report that it is waiting on the user, and carry on with what is not blocked. It raises the Needs-you item with the command, what it does and why; the user runs it from the Podium or marks it done.
- Command blocks for the user to paste: run `node <maestro scripts dir>/paste-lint.ts` on the block (a file or stdin) and fix every finding before handing it over; `ask --paste` refuses a block with findings.
- PHI: counts and ids only. No names, DOBs, addresses, MRNs, or contact details, anywhere.
- Waits: foreground only. Never run_in_background, background watchers, or Monitor, and never poll an output file in an until/sleep loop (that is how an agent hangs). Run tests in the foreground under a hard timeout, targeted ones only (e.g. `timeout 240 node --test path/to/one.test.ts`); if one hangs, stop and report which test, do not wait it out. To wait on an outside condition, use one blocking check sized to fit the tool timeout.
- Suites: never wait on a full test suite, and never sit idle more than 4 minutes between tool calls (the prompt cache lapses at 5, and the next turn then rewrites your whole context). For a repo whose tests run with node `--test`, start the suite with `node <maestro scripts dir>/suite-run.ts start` with the worktree path; for any other repo pass `--cmd` with that repo's own test command too (a run of zero tests fails). It returns a job id at once, registers the `suite-done` watch itself (pass `--no-watch` to skip that), and writes `results.json` when tsc and the tests finish, then exit: end with a findings note that names the job id and what the next agent must check. `suite-run.ts status` with the job id looks once and never blocks. A reviewer runs targeted tests plus tsc only, never the full suite, and reads the job's results instead. Opus agents (reviewers and builders alike) do not loop on full suites: ask for, or read, the `suite-summary.ts --typecheck` output (`node <maestro scripts dir>/suite-summary.ts --typecheck` run from the worktree, `--json` for the same data as JSON; `--runner jest` or `--runner pytest` for other repos) and spend your own runs on targeted probes. Sonnet and Haiku builders keep looping on tests and gates themselves; that is where the loop pays.
- Docs: a vault note you write for a ticket gets `ticket.mjs attach TICKET NOTE --kind KIND` before you report, or `ticket: none` in its frontmatter when it belongs to no ticket; an outside document gets `attach --url`. If your work changed an epic's state (closed or reopened a child, recorded a decision, found a risk), run `ticket.mjs brief EPIC --refresh` and rewrite its Status paragraph before you report.
- Scope: when you record an instruction the user gave in this conversation, use `journal.ts decide "the instruction" --why "the reason" --binds window` (or `rule`/`note` with `--scope window`) if it holds only here (pause, stop, ignore, focus on, "today" or "this window"), so other windows on the ledger do not read it as theirs; pass `--scope global` only when the user says it applies everywhere. `prime`, `status` and the footer show another window's scoped rules as one FYI line, never as binding.
- Tool output: request only the fields you need (Jira `fields=`, `gh ... --json a,b --jq ...`). Never paste raw logs or whole files; grep for counts and markers. Wrap long jobs in a script that prints a summary.
- Necessity: before building, answer in the report: do we need this? Does something already exist (config, flag, helper, framework hook, an earlier PR) that does it, or that a small refactor would make do it? Name the nearest existing mechanism and why it is not enough; if it is enough, stop and say so instead of building. Start from the Prior art section of your brief, and report any prior art it missed.
- Preflight: if mithril is installed, run its `playbooks/preflight.md` checklist on your diff before handing back and say in the report what it caught; if it is not installed, skip this.
- Learned: end your report with one line per fact you established that a later agent would otherwise have to re-derive (how something works, a gotcha, how to do a recurring thing), in the form `Learned: claim | kind | applies-to | evidence | verified-at | confidence` (kind how-to, how-it-works, gotcha, decision or tool; applies-to repo:component[:env]; confidence observed, told-by-jack or inferred), or record it yourself with `node <maestro scripts dir>/journal.ts learned --help`. Systems, ids and counts only: evidence is a path, a PR or a command and its count, never a secret or PHI value; a value-shaped claim is refused. Leave out status and restated decisions.
- Retro: before you hand back, run `node <maestro scripts dir>/journal.ts agent-retro <id> --lesson "code: ..." --lesson "jack: ..." --lesson "process: ..."` (or `--nothing "why there was nothing to learn"`): every lesson from the code or from the user, and anything else important, one line each, with the `Learned:` facts linked by `--learned <id>` once recorded. `done` refuses a briefed item without a retro. The brief's Retro section has the command with the id filled in.
- Rework: run `journal.ts log <id> --kind rework` when the output had to be edited before use.
- Report: write the full report to a file (a vault note or report path the brief names) and hand back only a few lines, a headline under 150 words and shorter when it can be, plus that file path: outcome, numbers, links, decisions needed, what is left open. Never paste the report, logs or JSON into the final message. If tests failed or a step was skipped, say so in the headline.
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

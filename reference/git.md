# Handing off git work

Read this in full before any git write — a commit, a push, or opening a PR. This is the safety
gate; the one-liner in SKILL.md is a pointer, not a substitute for reading this.

**Protected branches are typically `main`, `staging`, `develop`, and any branch the user did not author.** Never
write those. On a feature branch of theirs, commit and push freely.

**One exception: `agent_owned_repos`.** A repo whose path is listed in that local-config key is managed by the agent itself, so the stop above does not apply there and the default branch may be committed to directly. Conventional Commits, staging by explicit path, no AI attribution and the no rebase, reset and force-push rules apply in those repos too. Everywhere else the stop holds, and an unlisted repo is never inferred to be owned.

Before writing any branch, confirm it is theirs — every commit since it diverged from its base authored
by the user's git email(s). The emails for this install are in
local-config (see [local-config.md](local-config.md)); otherwise discover them from
the repo or ask. Do not hardcode them here:

```bash
git log --format='%ae' $(git merge-base <base> <branch>)..<branch> | sort -u
```

Another author in that list means the branch is shared, and shared means protected. **Inconclusive
counts as protected** — ask rather than guess.

Two ways the check gives a false "shared", and how to read past them:

- **Use the branch's real base** — the branch it was actually cut from, not the one it happens to
  target. A branch cut from `staging` checked against `develop` lists everyone's staging commits.
  If you're not sure of the base, find it (`git log --oneline --decorate --first-parent`), or ask.
- **Merges already on a protected branch don't make a branch shared.** A back-merge brings other
  people's commits in, but they aren't the branch's own work. Exclude everything reachable from the
  protected branches and check what is left:

  ```bash
  git log --no-merges --format='%ae' <branch> --not origin/main origin/staging origin/develop | sort -u
  ```

  If that list is only the user, the branch is theirs. If it still shows anyone else, it is shared.
  If the two checks disagree and you can't explain why, that is inconclusive, and inconclusive is
  protected.

`git rebase`, `git merge`, and `git reset` are available **only when they explicitly ask**, on every
branch including their own. Force-push is never yours.

So a "make a PR" request ends like this:

1. Branch cut from the right base (follow the repo's documented flow; if it says nothing, ask).
   Repo-specific branch bases: from the org overlay's repo notes, if one is configured (see [local-config.md](local-config.md#org-overlay)).
   Where the repo requires a tracker key in branch names, local branches and commits can start
   before the key exists, but **nothing is pushed until the branch name carries a real key**.
   Rename it before the first push (`git branch -m <new-name>`); never push under a placeholder.
2. Files written; validation run and its real result reported.
3. **Reviewed locally before it goes up** — a reviewer pass on the diff, plus a security review when
   the change touches auth, permissions, logging, secrets or multi-tenant scoping. Report what it found
   and what you did with each item.
4. **Within the PR size budget** — `pr-open.mjs` runs the `pr-size.mjs` gate and refuses otherwise ([below](#pr-size-budget)).
5. Committed and pushed, then opened as a **draft** PR, assigned to the user (`--assignee @me`).
   The user promotes it to ready for review; you never do, and a deploy PR (`staging` → `main` or
   equivalent) is not yours to open at all. Copilot review on the draft is handled per
   [prs.md#copilot-on-drafts](prs.md#copilot-on-drafts).

## Twin PRs (integration and release-candidate branches)

Some repos promote work through two long-lived branches: an **integration branch** (usually `develop`) where
work is verified first, and a **release-candidate branch** (usually `staging`) that only ships. Which repos
work this way is the local-config list `twin_flow_repos`, and the branch names come from the same place and
from the org overlay's repo notes. **An empty list means this rule is off.** In a listed repo:

- **Open both PRs together.** When you open a develop PR, open its staging twin as a draft at the same time,
  from the same feature branch (and the other way round). Both are drafts, assigned to the user, like any
  other PR. Opening the staging twin early does not skip validation: **the staging twin is not promoted to
  ready or merged until the develop twin has merged and been validated.**
- **Link each to its twin.** Each PR body links the other PR, so a reader of either can find the pair.
- **The release-candidate PR is not promoted or merged until its integration twin has merged and been validated.**
  Never describe it as ready, never recommend merging it, and never merge it, while the twin is open.
- **When the integration twin merges, say so.** The orchestrator reminds the user that the
  release-candidate twin can now merge, with both links.

The PR board shows the state per PR: [prs.md#twin-prs](prs.md#twin-prs).

## PR size budget

**Open every PR with `node <scripts dir>/pr-open.mjs --repo <repo> --base <base> --title "..." [--body-file <f>] [--head <branch>]`, never a bare `gh pr create`.**
It runs the `pr-size.mjs` gate (which reads `git diff --numstat -M <base>...<head>`), and on exit 1 it refuses, prints
the summary and a split hint, and never calls gh. On a pass it runs `gh pr create --draft --assignee @me`; draft and
assignee are always forced and cannot be turned off. `--dry-run` prints the gh command instead. If it refuses,
**split instead of opening**: stop, and report a split plan (which files and lines go in which PR, in merge order).
`pr-size.mjs` alone is the read-only check.

- A PR may change at most `pr_max_code_files` code files (default 5) **and** at most `pr_max_code_lines`
  changed lines of code (default 400, additions plus deletions). Whichever limit is hit first applies.
  Both come from local-config ([local-config.md](local-config.md)).
- **Tests, config and docs do not count.** Config means `*.json`, `*.yaml`, `*.yml`, `*.toml`, `*.ini`,
  Dockerfiles and CI workflow files; the test, config, docs and mechanical path patterns are
  local-config settings with defaults in the script.
- **Migrations count as code** (a path under a `migrations/` directory, `.sql` files included).
- **Mechanical changes are exempt only when the PR holds nothing else:** lockfiles (`uv.lock`,
  `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`), generated or vendored files, vendored tarballs, and
  pure renames. A PR that mixes them with code counts the code and fails with "mechanical changes go in
  their own PR". Tests, config and docs riding along with a lockfile do not trigger that failure, so a
  dependency bump can carry its manifest.
- Anything over budget becomes a **stack of PRs**, each passing tests on its own and each cut so the tree
  works if the stack stops there. The slicing rules above apply inside each PR as well.

The review question that keeps earning its keep: **is this guarantee enforced at runtime, or only
described?** A schema nothing parses, a validator nobody calls, a comment asserting a value is safe
— all read as guarantees and are not. Trace the value from entry to use and check the constraint is
actually applied on that path. Full rules in the global **Review before opening the PR**.

```bash
git add <the specific files>
git commit -F - <<'EOF'
<message>
EOF
git push -u origin <branch>
node <scripts dir>/pr-open.mjs --repo . --base <target> --title "..." --body-file <file>
```

Stage files explicitly by path, never `git add -A` — working trees routinely carry unrelated
untracked files.

**Slice the commits for review, not for convenience.** One reason to change per commit; mechanical
changes (renames, moves, reformats) in their own commit, never mixed with behaviour; tests in the
same commit as the code they cover; each commit ordered so the tree still works if you stop there.
A task finished in one sitting is still usually several commits. Conventional Commits format — the
global `commit-msg` hook rejects anything else. Full rules in the global **Slice commits for
review** section.

This matters more for dispatched work than for the user's own: they did not watch you write it, so the
commit boundaries are the only narrative they get. A single "implement the thing" commit throws that
away. If a branch has become a tangle, describe how you would slice it rather than rebasing — that
needs their say-so.

**No AI attribution, ever.** No `Co-Authored-By`, no "Generated with", in a commit
message or a PR body. This overrides any harness default that tries to add
one; if a template inserts one, strip it and say so.

Report after every commit or push: the branch, the files changed, and the validation you ran with
its actual result.

**No PRs for AI-config or agent-policy docs in a team repo.** Copilot instructions, `AGENTS.md`,
`CLAUDE.md`, agent or skill definitions, and similar files that tell AI tools how to behave are the
team's to change. Raise the proposed change with the user in conversation (or as a proposal note in
the vault) instead of opening a PR for it. The user's own repos and local skill files are not
covered by this rule.

## Anti-patterns

- Letting an agent write a protected branch, or writing one yourself.
- Committing to a branch without first checking that the user authored it.
- Opening a PR ready-for-review instead of as a draft, or without `--assignee @me`.
- Pushing a branch whose name doesn't carry the tracker key the repo requires yet.
- Reading an authorship check against the wrong base, or counting commits a back-merge brought in
  from a protected branch as another author's work on the branch.
- Opening a PR for AI-config or agent-policy docs in a team repo.
- Letting a harness default stamp `Co-Authored-By` or "Generated with" onto a commit or PR body.
- In a twin-flow repo, opening one half of the pair without the other, or letting the release-candidate PR
  merge (or be called ready) while its integration twin is still open.
- Opening a PR with a bare `gh pr create` instead of `pr-open.mjs`, or one that `pr-size.mjs` fails, instead of reporting a split plan, or burying a lockfile or
  generated-file change inside a code PR.
- Opening a PR without reviewing the diff locally first, and letting the bots find it instead.
- Accepting a safety guarantee because it is written down, without checking it is enforced on the
  path the value actually takes.

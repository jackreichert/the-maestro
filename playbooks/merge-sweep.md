# Playbook: merge-sweep standing pickup (for a cheap runner)

You are the runner. The `merge-sweep` standing pickup is due. The sweep has five steps and each is its own command, so each can be allowed or refused on its own. Run them in order, copy the lists into your report, and never close a ledger row or delete a branch by any other route.

| Step | Command | Writes | Reversible |
|---|---|---|---|
| 1. Read | `merge-sweep.ts --json` | nothing | n/a |
| 2. Close ledger rows | `merge-sweep.ts --close-ledger` | appends `done` to local ledger rows whose linked PRs all merged | yes (the ledger is append-only and local) |
| 2b. Prune Others' PRs | `merge-sweep.ts --prune-others --json` | drops settled teammate PR cards from the Podium's Others' PRs cache and rejects the review drafts queued for them | the prune is remembered, so a rebuild keeps the card off until the PR changes and the rules no longer settle it; a rejected draft keeps its text and reason |
| 2c. Resync the loop daemon | `merge-sweep.ts --resync-runtime --json` | fast-forwards the daemon's worktree to origin/main and restarts it, only when clean, a pure fast-forward and CI `test` is green on that commit | yes (`git checkout <old sha>` in the runtime worktree, then restart; both shas are logged) |
| 3. Delete branches | `branch-sweep.ts --apply --ids ...` | deletes remote branches from a fresh listing | no, but each deletion prints a `restore` line first |
| 4. Harvest review misses | `review-harvest.ts harvest --since <7 days ago>`, then [review-miss-harvest.md](review-miss-harvest.md) | the local harvest store, triage lines, and the weekly note | yes (local files; the note is never overwritten) |

## 1. Read

From the skill root:

```bash
node scripts/merge-sweep.ts --json [--vault <ledger root>] [--project <name>]
```

It needs `gh` logged in. It reads open ledger rows of kind `wip` or `blocked` that name a pull request as `gh:pr:owner/repo#N`, `owner/repo#N`, a github.com pull URL, or `repo#N` for a repo whose owner is configured, and asks `gh` for each PR's state. A `question` or a pending `decision` is never matched, however it cites a PR: a merge does not answer it (the JSON counts them as `skipped`). A PR it cannot read is unknown, never merged.

Read the JSON by these fields only: `actions` (rows left for a decision, plus 1 for a blind sweep), `closedCount`, `blind`, and the lists `merged`, `stale`, `unknown`, `closed`, `autoClosed` (each row has `id` and `text`). `--stale-days` defaults to 7. `--today YYYY-MM-DD` is for a fixed clock; omit it. Run it in the foreground. Do not call `gh` yourself, and do not read the ledger to decide which rows are merged.

| Exit | Meaning | You do |
|---|---|---|
| 0 | `actions` is 0: every named PR was read, and none is merged-but-open, stale, or closed without merging. | Step 2 only if a row in `merged` has `closable: true` (with exit 0 there is none, so skip to step 3). |
| 1 | At least one merged, stale, or closed-without-merging row. Unknown rows may be listed too. | Step 2, then step 3. |
| 2 | Usage or read error (no ledger, bad flag, ledger root unset). | Report the stderr line. Fix the arguments once; if it fails again, stop. |
| 3 | No merged, stale, or closed-without-merging rows, but a PR could not be read, or `blind` is true because the sweep parsed 0 PRs from the open rows. | Report. A blind sweep is `merge-sweep: BLIND, not clean`. Do step 3 only if it is not blind. |

## 2. Close ledger rows

```bash
node scripts/merge-sweep.ts --close-ledger --json [--vault <ledger root>] [--project <name>]
```

This is the only ledger write the sweep makes, and it closes only a `wip` row linked to its PR through refs (`pr-open.ts` writes the link) once every PR on the row is MERGED. A row that only mentions a PR in its text, a `blocked` row, or a row with another PR still open or unreadable is listed and left open. It never touches a branch. Rows it closed are in `autoClosed`. `--close` is the old name for the same flag. If the command is refused or fails, report it and go on to step 3; do not retry with other flags.

## 2b. Prune the Others' PRs tab

```bash
node scripts/merge-sweep.ts --prune-others --json [--vault <ledger root>] [--project <name>]
```

Run it with step 1's flags (it repeats the read, so it may be combined: `--close-ledger --prune-others --json`). It reads each cached teammate PR once and drops the card, and rejects any pending review draft, when the PR is merged or closed, or when someone other than the user, the PR's author and the bots has reviewed it or left an inline comment. A PR the user was asked to review and has not reviewed stays. `pruned` in the JSON lists `cards`, `drafts` and `unread` (PRs it could not read, left in place); each pruned item is also a `merge-sweep: pruned card ...` or `rejected draft ...` line on stderr. Running it again prunes nothing. If it fails, report it and go on.

## 2c. Resync the loop daemon

```bash
node scripts/merge-sweep.ts --resync-runtime --json [--vault <ledger root>] [--project <name>]
```

The loop daemon runs from a detached runtime worktree that nothing else moves, so a merged maestro PR is dead there until this runs. Run it after step 2 (it can be combined: `--close-ledger --prune-others --resync-runtime --json`). `runtimeResync` in the JSON is `{ action, old, new, reason }`: `resynced` (moved and restarted), `current` (nothing to do, no restart), `refused` (not clean, not a pure fast-forward, or CI `test` on that commit is not green; the reason says which) or `error` (moved, but `launchctl kickstart` failed). Each outcome is a `merge-sweep: runtime-resync: ...` line on stderr with the old and new shas. Never fast-forward, reset or restart by hand, and never retry a refusal: report it. The hourly loop sweep runs this itself, so you only see `refused` when something needs a person.

## 3. Delete merged branches

Standing approval covers a remote feature branch that passes all of these: every commit on it is by one of the configured `git_emails` (or the repo's own `user.email`), it is merged into the base (ancestry or a merged PR, not patch-equivalence alone), and no PR on it is open. `branch-sweep.ts` applies exactly this rule; you do not re-judge it.

`<container_root>` is the `container_root` setting (the directory that holds the repos); the dispatch brief gives it, and if you do not have it, report that and skip this step.

List first, read-only:

```bash
node scripts/branch-sweep.ts --json --container <container_root>
```

Take the `id` of each item in `items` whose `kind` is `remote-branch`. Ignore worktrees (the roll handles them), everything under `review` (patch-equivalent only) and everything under `excluded`. If there are none, skip the delete. Otherwise:

```bash
node scripts/branch-sweep.ts --apply --ids <id,id,...> --container <container_root>
```

For each branch it prints `restore <id>: git -C <repo> push origin <sha>:refs/heads/<branch>` before deleting, then `ok` or `REFUSED` with a reason. It re-scans first and refuses a branch that moved, no longer qualifies, has an open PR, or whose PRs it could not read. Copy every `restore` line into your report. Never pass an id from an older listing or one you made up. If the command is refused by a permission prompt or a classifier, report that and stop: do not try another way to delete.

## 4. Harvest review misses

Merged PRs carry what reviewers found that the author missed; this step reads it, whether or not step 2 closed a row. It is read-only against GitHub and idempotent, so it is safe to run every sweep:

```bash
node scripts/review-harvest.ts harvest --since <7 days ago, YYYY-MM-DD>
node scripts/review-harvest.ts pending --json
```

If anything is pending, follow [review-miss-harvest.md](review-miss-harvest.md) to triage it, and when nothing is pending and this week has no note yet, write it with `batch --write`. If the harvest exits 2, report its line and carry on. Never edit a mithril skill: candidates stay proposals in the note.

## 5. Report back

Report at most 20 lines, then stop:

1. `merge-sweep: <clean | N actions | BLIND>`, the step 1 exit code, and `closedCount`
2. one line per row in `autoClosed`: `<id> -> closed by --close-ledger`
3. one line per merged row left open: `<id> -> not closed` plus its reason (`other PRs on this row are not merged`, `not linked through refs`, or `not a wip row`)
4. one line per stale row: `<id> -> <owner/repo#N> open, idle`
5. one line per unknown row: `<id> -> could not read, not merged`
6. one line per closed-without-merging row: `<id> -> closed unmerged, not closed`
7. one line per deleted branch: its `restore` line; one line per `REFUSED`: `<id> -> <reason>`
8. `pruned: <N> cards, <M> drafts` from `pruned` (step 2b), one line per card as `<repo>#<n> -> <reason>`
9. `runtime: <action> <old> -> <new>` from `runtimeResync` (step 2c), plus the reason when refused
10. `harvest: <N> new findings, <M> pending, note <path or none>`

Do not paraphrase `MERGED`, `OPEN`, `CLOSED`, or `UNKNOWN`. If a list has more rows than fit, end with `+N more`. Do not paste raw JSON, `gh` stderr, or logs. If `actions` is 0, nothing was closed and nothing was deleted, the whole report is `merge-sweep: clean` plus the harvest line.

## Hard rules

- The only ledger write is `merge-sweep.ts --close-ledger`; the only Podium write is `--prune-others`; the only daemon write is `--resync-runtime`. Never run `journal.ts done`, never close, drop or resolve a row by hand, never edit `ledger.jsonl` or `standing.jsonl`. Never close a `question`, `decision` or ask row.
- The only deletion is `branch-sweep.ts --apply --ids` from a listing you just made. No `git push --delete`, no `git branch -D`, no `--force`.
- Never treat `UNKNOWN` as merged, and never treat a PR the script did not list as merged. A missing read is not a merge.
- Do not sync an overlay, merge, comment, or push. Do not record `journal.ts standing done` yourself; the orchestrator does that after reading your report.
- Any recursive `grep` or `rg` carries `--exclude='.env*' --exclude='ssm-*.json'`, and you never open those files. You should not need to search at all.
- A clean exit is not permission to mark a row done.

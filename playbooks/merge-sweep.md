# Playbook: merge-sweep standing pickup (for a cheap runner)

You are the runner. The `merge-sweep` standing pickup is due. You run one script with `--close` and copy its lists into your report. The script itself closes a row whose linked PRs have all merged. You never close a ledger row yourself, and you do not run the `journal.ts done` command the script prints for the rows it left open.

## 1. Run it

From the skill root:

```bash
node scripts/merge-sweep.ts --close [--vault <ledger root>] [--project <name>]
```

It needs `gh` logged in. It reads open ledger rows that name a pull request as `gh:pr:owner/repo#N`, `owner/repo#N`, a github.com pull URL, or `repo#N` for a repo whose owner is configured, asks `gh` for each PR's state, and prints the lists below. With `--close` it appends `done` to a row that is linked to a PR through its refs (`pr-open.ts` writes the link) once every PR on the row is MERGED, and it lists those rows under `Closed on merge`. A row that only mentions a PR in its text, or has another PR still open or unreadable, is not closed. A PR it cannot read is unknown, never merged. Without `--close` it is read-only. Add `--json` only if the orchestrator asks for machine output. `--stale-days` defaults to 7 (whole UTC days since the PR's `updatedAt`). `--today YYYY-MM-DD` is for a fixed clock; omit it.

Run it in the foreground. Do not call `gh` yourself, and do not read the ledger to decide which rows are merged.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Every named PR was read. None is merged, stale, or closed without merging. | Report `merge-sweep: clean`, plus the `Closed on merge` rows if any. |
| 1 | At least one merged, stale, or closed-without-merging row. Unknown rows may be listed too. | Step 2. Do not close anything. |
| 2 | Usage or read error (no ledger, bad flag, ledger root unset). | Report the stderr line. Fix the arguments once; if it fails again, stop. |
| 3 | No merged, stale, or closed-without-merging rows, but at least one PR could not be read, or the output starts with `WARNING` because the sweep parsed 0 PRs from the open rows. | Step 2, unknown only. Those PRs are not merged. Report a WARNING as `merge-sweep: BLIND, not clean`. |

## 2. Report back

Copy the heading and the rows of each non-empty list. Do not paraphrase `MERGED`, `OPEN`, `CLOSED`, or `UNKNOWN`.

Report at most 12 lines:

1. the exit code, then one line per row under `Closed on merge`: `<id> -> closed by the script`
2. one line per merged row: `<id> -> journal.ts done <id>, not run` — if the script printed `(other PRs on this row are not merged)`, add `not ready to close`
3. one line per stale row: `<id> -> <owner/repo#N> open, idle`
4. one line per unknown row: `<id> -> could not read, not merged`
5. one line per closed-without-merging row: `<id> -> closed unmerged, not closed`

If a list has more rows than fit, end with `+N more` and stop. Do not paste raw JSON, `gh` stderr, or logs.

## Hard rules

- Never run a `close if you agree:` line. Never run `journal.ts done`. Never close, drop, or resolve a ledger row by hand; the only close is the script's own `--close`. Never edit `ledger.jsonl` or `standing.jsonl`.
- Never treat `UNKNOWN` as merged, and never treat a PR the script did not list as merged. A missing read is not a merge.
- Do not delete branches, sync an overlay, merge, comment, or push. This playbook is the read. Branch deletion is a separate sweep and needs approval.
- Do not record `journal.ts standing done` yourself. The orchestrator records the standing run after reading your report.
- A clean exit is not permission to mark a row done.

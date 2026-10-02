# Playbook: wait for a PR to merge or its checks to finish (for a cheap runner)

You are the runner. You wait, in the foreground, for one pull request to reach one outcome, then report it in one line. You do not fix, re-run, comment, merge or investigate anything. For waits that must outlive this session, the orchestrator registers a watch instead ([event-loop.md](event-loop.md)).

## 1. Find the helper

This needs a `wait-for-pr` helper on PATH or in `<scripts_dir>/helpers/` ([README.md](../README.md#the-scripts-shelf)). Run `wait-for-pr --help`; it prints usage and exits 0 without doing work. If there is no such helper, report `no wait-for-pr helper` and stop. Do not write a polling loop of your own.

The helper contract:

```bash
wait-for-pr <owner/repo> <number> merged|checks [--timeout SECS] [--interval SECS]
```

- `merged` waits until the PR is merged. `checks` waits until every check has finished.
- Read-only. It prints one summary line, and exits with a code.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Done: merged, or all checks finished green. | Step 3, report success. |
| 1 | The PR closed unmerged, or a check failed. | Step 3, report failure. |
| 2 | Usage error (bad arguments). | Report the stderr line. Fix the arguments once; if it fails again, stop. |
| 3 | Timeout. | Step 3, report that it is still pending. Do not wait again unless the orchestrator said to. |

## 2. Run it

Take `<owner/repo>`, `<number>` and the mode (`merged` or `checks`) from the orchestrator's brief. Pick `--timeout` so the call fits the tool's own time limit (the default is the helper's), and run it in the foreground. Never run it in the background and never poll it from another loop.

```bash
wait-for-pr <owner/repo> <number> <merged|checks> --timeout 540 --interval 20
```

## 3. Report back (one line)

`<owner/repo>#<number>: <merged | closed unmerged | checks green | checks failed | still pending after <N>s>`, plus the PR link. For a failed check, add the check names if the summary line lists them; do not fetch logs.

If the helper prints a `gh error` line on every try (login expired, PR not found), the timeout will come back as exit 3; say that the PR could not be read, not that it is pending.

## Hard rules

- Do not re-run, cancel or comment on checks, and do not merge, approve or close the PR.
- Do not paste logs or raw JSON into the report.
- Do not loop on exit 3. One wait, one report.

# Event type: pr-checks

CI status of one pull request. Script: [scripts/event-types/pr-checks.mjs](../../scripts/event-types/pr-checks.mjs).

Register: `node scripts/event-loop.mjs add --id ci-<n> --type pr-checks --target <owner>/<repo>#<n> --report "<what to tell the orchestrator>"`.
`--done-when passing` waits for all green; the default (`settled`) retires the watch once no check is pending, pass or fail.

## What the loop reports

| Digest line | Actionable? | What to report |
|---|---|---|
| `CI failing: <check names>` | yes | The PR, the failing check names (at most five are listed). Do not fetch logs. |
| `CI passing (N checks)` | yes | The PR and that it is green. |
| `CI is pending` | no | Nothing. A push restarted the checks. |

A failing PR with checks still running is reported at once, and again only if the set of failed checks changes. After `settled` the watch retires; if the author pushes a fix, the orchestrator registers a new watch.

A PR with no checks yet reads as `none` (silent). If `gh` fails for any other reason (login expired, PR not found) the loop reports `check keeps failing` after three tries; say so rather than treating it as green.

## Do not

Re-run, cancel or comment on checks, and do not paste logs. Report the line and stop.

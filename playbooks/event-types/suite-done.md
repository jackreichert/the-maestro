# Event type: suite-done

A detached test-suite job finishing. Script: [scripts/event-types/suite-done.ts](../../scripts/event-types/suite-done.ts). The job comes from [scripts/suite-run.ts](../../scripts/suite-run.ts), which runs `tsc --noEmit` and `node --test` in a worktree with no model attached and writes `results.json` last. Target is the job id `suite-run.ts start` printed.

Register: `node scripts/event-loop.ts add --id suite-<job> --type suite-done --target <job id> --report "<what to do with the results>"`. A few hours is the default time to live; the watch retires itself on the event.

## What the loop reports

| Digest line | Actionable? | What to do |
|---|---|---|
| `suite <job>: PASS at <sha>; tsc ok; tests N pass, 0 fail, 0 cancelled; start a fresh reviewer with the diff and results.json` | yes | Start a fresh reviewer (Sonnet after the first round) with the diff and `results.json`. The reviewer runs targeted tests and tsc only, never the suite. |
| `suite <job>: FAIL at <sha>; ...; failing: <names>; ...` | yes | Hand the failing names to a fixer with the diff. The fixer runs targeted tests only, then starts a new job. |
| `suite <job>: lost (the worker exited without results; see output.log)` | yes | The job died. Read `output.log` in the job directory and start the job again; do not wait on it. |

Batch these into the digest: one more wake per suite is the whole cost, instead of an agent idling past the five-minute cache window.

## Do not

Wait on a job, poll it in a loop, or run the suite yourself to check it. `suite-run.ts status <job>` looks once and returns; it exits 4 while the job runs.

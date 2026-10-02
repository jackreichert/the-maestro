# Event type: gh-run

One GitHub Actions run, watched until it completes. Script: [scripts/event-types/gh-run.mjs](../../scripts/event-types/gh-run.mjs).

Register: `node scripts/event-loop.mjs add --id run-<id> --type gh-run --target <owner>/<repo>:<run id> --report "<what to tell the orchestrator>"`.

## What the loop reports

| Digest line | Actionable? | What to report |
|---|---|---|
| `run "<name>" completed: <conclusion>` | yes | The run name and conclusion (`success`, `failure`, `cancelled`, ...). The watch then retires. |
| `run "<name>" is <status>` | no | Nothing. |

## Do not

Re-run the workflow or read its logs. If the conclusion is not `success`, say so and let the orchestrator decide.

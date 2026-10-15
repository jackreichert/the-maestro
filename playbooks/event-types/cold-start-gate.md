# Event type: cold-start-gate

Runs the cold-start gate once a week inside the event loop, with no model. Script: [scripts/event-types/cold-start-gate.ts](../../scripts/event-types/cold-start-gate.ts), which runs [scripts/drills/real-state-gate.ts](../../scripts/drills/real-state-gate.ts). Target is the project name (the project whose ledger is under `ledger_root`).

Register: `node scripts/event-loop.ts add --id cold-start-gate --type cold-start-gate --target <project> --notify`. One watch only; it renews itself. A passing run is silent, so `--notify` only ever sends a failure.

## What one run does

Seven days after the last clean run (or on the first check), the gate copies the project's Journal into a temporary directory, runs the SessionStart hook there for `startup`, `compact` and `clear`, and checks that each context names every open in-flight, blocked, queued and asked item and the newest priorities file. The real ledger and vault are only read. The temporary directory is removed.

## What the loop reports

Nothing, normally. When facts are missing, or the gate cannot run, one actionable line says so and the run is retried after a day:

| Digest line | What to do |
|---|---|
| `cold-start gate failed: N facts missing from the start context (<ids>)` | Run `node scripts/drills/real-state-gate.ts --project <project>` by hand. Each `MISSING <source>: <kind> <id>` is an item a new session would not see. Look up the id with `journal.ts` and find why the cold-start page dropped it (a cap, a stale registry, an archived stream). Do not edit the ledger to make it pass |
| `gate printed no result` | The gate crashed or `ledger_root` is unset; the last stderr line is shown. Run it by hand |

The same message repeating on the daily retry is not raised again. `PENDING` lines in the manual output are facts waiting on unmerged work; they do not fail the gate.

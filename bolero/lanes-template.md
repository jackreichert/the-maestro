# Lanes plan

Copy this into the run's plan note and fill it in after the scout reports, before the first dispatch. Update it on every pass: it is the record of which slice is where. Rules behind each field are in [SKILL.md](SKILL.md).

## Run

- Stream:
- Queue source and read time: `journal.ts priorities show`, read fresh at:
- Repo(s) and base branch:
- Integration branch and worktree: `local/integration-<stream>` at `<container>/.worktrees/<repo>-integration-<stream>`
- Pushes allowed: yes (own repo, drafts via `scripts/pr-open.ts`) / no (held local until the user says)
- Review queue: `journal.ts review-queue` exit code and time

## Items

One row per queue item, after the liveness check ([reference/dispatch.md](../reference/dispatch.md#pre-dispatch-liveness-check)). An item that failed it goes back to the queue with the failed check named.

| Item (id and title) | Live? | Files it will touch | Depends on | Lane | Model |
|---|---|---|---|---|---|
| | yes / no, which check | | none / item | A | sonnet |

## Lanes

| Lane | Items, in order | Worktree path | Branch | Writer (agent task name) | Status |
|---|---|---|---|---|---|
| A | | | | | queued / running / done / blocked |

## Overlap check

Two lanes may run at once only if their file sets are disjoint and they share no external state (database, port, container).

- Files per lane, and any file that appears in two: sequence those items in one lane or in later slices.
- Shared external state: none / list it and sequence the lanes.

## Merge order on the integration branch

Dependency order, one branch at a time, full suite after each ([SKILL.md](SKILL.md#the-integration-branch)).

1. branch, then suite result (command, exit code)

## Slices

| Slice | Lanes launched together | Gate before the next slice |
|---|---|---|
| 1 | | all lanes reported; merged and green on the integration branch |

## Blocked

Each blocked item names what it waits for. A user decision is an `ask`; an external block is `log --kind blocked`, with `--gate gh:pr:<repo>#N|date:YYYY-MM-DD|ticket:<id>` only when the wait ends on one of those ([SKILL.md](SKILL.md#stopping)).

| Item | Kind (decision / unexplained failure / external) | Waits for | Asked on | Lanes still moving |
|---|---|---|---|---|

## Landings

For each landed lane: head sha, suite result, `learned` entries recorded (when `journal.ts learned` is available), and any incidental findings filed as their own tickets.

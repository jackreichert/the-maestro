# Event type: retro-due

Reports when agent retros are waiting for review. Script: [scripts/event-types/retro-due.ts](../../scripts/event-types/retro-due.ts). Target is the status directory (any existing directory; the ledger is found from the configured project). One watch; `session-start.ts` registers it.

Register: `node scripts/event-loop.ts add --id retro-due --type retro-due --target <status dir>`. It checks every 60 seconds, renews itself like the other standing watches, and does not notify unless added with `--notify`.

## What it watches

An `agent-retro` row is waiting until a `retro-reviewed` row closes it. A briefed item closed by `done` without a retro (including `done --no-retro "<why>"`) is waiting too, until a `retro-reviewed` row names it; only items closed after the first retro row on the ledger count. The loop reads the ledger only when its file changes. A review is due when at least one is waiting and either 10 or more are waiting, or 3 hours have passed since both the last review and the oldest waiting one, so retros are reviewed every few hours in batches.

It speaks once per batch. It stays silent until a new `retro-reviewed` row appears. If none appears within 3 hours it speaks once more. Review rows never raise the waiting count, so a review cannot wake itself.

## What the loop reports

| Digest line | Actionable | What to report |
|---|---|---|
| `retro-due: N agent retros to review, oldest 3h` | yes | The line as it is. |
| `retro-due: N agent retros to review, M briefed items closed without one, oldest 3h` | yes | The line as it is; the second part appears only when briefed items closed without a retro. |

## What you do

Report the line and stop. You never review or promote a lesson yourself: the orchestrator dispatches the retro reviewer ([playbooks/retro-review.md](../retro-review.md), Sonnet), which reads `journal.ts agent-retros` and closes each one with `journal.ts retro-reviewed`.

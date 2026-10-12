# Event type: stall

Reports a dispatched agent that has shown no progress for `stall_minutes` (default 90). Script: [scripts/event-types/stall.ts](../../scripts/event-types/stall.ts). Target is the container directory (the folder holding your repos, where each repo and its worktrees live). One watch.

Register: `node scripts/event-loop.ts add --id stall --type stall --target <container dir> --ttl-hours 72`. It checks every 300 seconds, renews itself like the other standing watches, and does not notify unless added with `--notify`.

## What it watches

An in-flight item that `journal.ts brief` dispatched for a writer (its claim row names the repo and the worktree or branch). Progress is the newest of the dispatch itself, the worktree's `HEAD`, reflog and index files, and the mtime of every file `git status` lists as changed or untracked. Ignored files are not read. The lease is not used: it belongs to the orchestrator window and any row that window writes renews it, so it says nothing about the subagent.

An item with no claim (a read-only brief, work done in the orchestrator), a worktree git cannot read, or a claim already released is never judged. A stall is only reported when it can be shown.

The default of 90 minutes is more than double the 20 to 40 minutes a long test run under load can go quiet, so a run that is merely slow does not fire. Lower it with `stall_minutes` (or `MAESTRO_STALL_MINUTES`) only if your suites are short.

It speaks once per stall. The same stall is not repeated on later ticks. It speaks again only if the agent makes progress and then stalls again, or is re-dispatched and stalls again.

## What the loop reports

| Digest line | Actionable | What to report |
|---|---|---|
| `stalled <id> (<repo>, worktree <name>): no progress for 1h42; newest sign edited a.ts at 2026-10-11T22:00Z. Run the stall-reset playbook.` | yes | The line as it is. |

## What you do

Report the line and stop. The loop cannot stop a subagent and neither can you; the orchestrator does, following [playbooks/stall-reset.md](../stall-reset.md).

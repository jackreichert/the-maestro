# Event type: stall

Reports a dispatched agent that has shown no progress for `stall_minutes` (default 90). Script: [scripts/event-types/stall.ts](../../scripts/event-types/stall.ts). Target is the container directory (the folder holding your repos, where each repo and its worktrees live). One watch.

Register: `node scripts/event-loop.ts add --id stall --type stall --target <container dir> --ttl-hours 72`. It checks every 300 seconds, renews itself like the other standing watches, and does not notify unless added with `--notify`.

## What it watches

An in-flight item that `journal.ts brief` dispatched for a writer (its claim row names the repo and the worktree or branch). Progress is the newest of the dispatch itself, the dispatch's report and scratch files, a live process in the worktree, the worktree's `HEAD`, reflog and index files, and the mtime of every file `git status` lists as changed or untracked. Ignored files are not read. The lease is not used: it belongs to the orchestrator window and any row that window writes renews it, so it says nothing about the subagent.

An item with no claim (a read-only brief, work done in the orchestrator), a worktree git cannot read, or a claim already released is never judged. A stall is only reported when it can be shown.

A single full test run under load has taken 40 to 60 minutes, and an agent often runs two back to back (its branch, then main to compare), writing nothing in the worktree for the whole stretch. So the worktree is not the only evidence. Also counted as progress: the newest write to the dispatch's report and scratch files (files beside the report path whose name holds the item id, except the brief), and a live process whose working directory is in the worktree (`lsof -a -d cwd`; without `lsof` this signal is absent and only the files count). The process check runs once the files have been quiet for half the limit, and a process last seen restarts the clock from that moment. The 90 minute default is the margin on top of those signals, not a bet that a run is short. Lower it with `stall_minutes` (or `MAESTRO_STALL_MINUTES`) only if your suites are short.

It speaks once per stall. The same stall is not repeated on later ticks. It speaks again only if the agent makes progress and then stalls again, or is re-dispatched and stalls again.

## What the loop reports

| Digest line | Actionable | What to report |
|---|---|---|
| `stalled <id> (<repo>, worktree <name>): no progress for 1h42; newest sign edited a.ts at 2026-10-11T22:00Z. Run the stall-reset playbook.` | yes | The line as it is. |
| `finished <id> (<repo>, worktree <name>): report <path> was written and nothing has moved for 1h42, but no hand-back arrived. Read the report first; do not re-brief this item ...` | yes | The line as it is, then read the report. Not a stall: do not reset. |

## What you do

Report the line and stop. The loop cannot stop a subagent and neither can you; the orchestrator does, following [playbooks/stall-reset.md](../stall-reset.md).

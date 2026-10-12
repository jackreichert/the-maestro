# Event type: continuity

Keeps a session's continuity current in the background, with no model, so a compaction (or a crash) finds the work already on disk. Script: [scripts/event-types/continuity.ts](../../scripts/event-types/continuity.ts). Target is the project's transcripts folder, for example `~/.claude/projects/<project>`.

Register: `node scripts/event-loop.ts add --id continuity --type continuity --target <transcripts dir> --ttl-hours 72`. One watch only.

## What one check does

Every 5 minutes it runs the same three steps as the PreCompact hook, in the same order, so the hook only has to verify:

| Step | Rule |
|---|---|
| Decisions | Every interactive transcript written to in the last 6 hours (subagent and headless ones are ignored) is scanned, and each message that looks like an unledgered decision is raised as an `ask` row |
| Handoff | When the whole-ledger handoff is older than the newest ledger row, or this check raised an ask, `<Journal>/HANDOFF-<date>-live.md` is rewritten |
| Snapshot | Dirty and untracked source of active worktrees is copied to the snapshot shelf, skipping what is already held byte for byte |

It takes a lock beside the ledger and does not wait: if a PreCompact hook or another check holds it, this check skips quietly.

## What the loop reports

Nothing, normally. A failed step is raised once per new message:

| Digest line | What to do |
|---|---|
| `continuity tick failed: <step>: <reason>` | `decisions: ...` means a transcript or `journal.ts ask` failed; `handoff: ...` means `journal.ts handoff --all` failed (run it by hand to see why); `snapshot: ...` means `scripts_dir` is unset or the copy hit its time or size cap |

A watch that outlives its TTL reports `watch expired before it finished`: register it again. If the tick is not running, the PreCompact marker says `repaired` and prime shows a `!!` line.

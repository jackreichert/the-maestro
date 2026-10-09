# Event type: roll-maintenance

Runs the loop-safe half of roll inside the event loop, once per local day, with no model and no orchestrator turn. Script: [scripts/event-types/roll-maintenance.ts](../../scripts/event-types/roll-maintenance.ts). Target is the container directory, the folder holding your repos (the `container_root` setting).

Register: `node scripts/event-loop.ts add --id roll-maintenance --type roll-maintenance --target <container dir> --ttl-hours 72`. One watch only. Add `--notify` to have a failure sent to `notify_command`.

## Why a watch, not roll or a standing row

`journal.ts roll` does this work, but only when someone remembers to run it, and `standing check` only reports that the work is overdue; neither runs it. The two roll steps with no judgement in them (archive the old done days, remove clean stale worktrees) are exactly what an unattended loop can do, so they move here and the rest of roll stays with the orchestrator.

## What one run does

The first check of each new local day (`watch_tz`) runs `journal.ts maintain --today <day> --container <target>`:

| Step | Rule |
|---|---|
| Archive | Each of the last 7 days before today that still owes an archive (work finished since that day's last roll, or notes with no roll) is written to its dated note, dropped from CURRENT, and the ledger is committed when `ledger_git_autocommit` is on. A day a roll already covered is left alone |
| Worktree sweep | Removes clean, idle, pushed worktrees and prunes missing ones, exactly as roll does: never `--force`, a dirty worktree is kept and listed, a remote branch is never touched |
| Standing row | A finished sweep records the `branch-sweep` run through the same guard roll uses (not on a dry run, a failed sweep or a retired row) |

It is idempotent (a second run finds nothing to archive or remove) and takes a lock beside the ledger, so a manual roll or a retry cannot overlap it. A clean run is silent and is not run again that day.

## What stays in roll

Triage and its box decisions, the epic-briefs and notes-reachable reports and what to do about them, env-file asks, the scratch review, the handoff note, the tracker transitions, the merged-PR sweep, the remote branch sweep and the commitments sweep all need judgement or an external write. Run `journal.ts roll` for those.

## What the loop reports

Nothing, normally. When a run fails (the ledger commit failed, the sweep could not fetch or start, `container_root` is unset or does not contain the target, another run held the lock, or the command crashed or timed out) it is retried after an hour and one actionable line says why:

| Digest line | What to do |
|---|---|
| `roll maintenance failed: <reason>` | Run `node scripts/journal.ts maintain --today <today> --container <dir>` by hand to see the full output. `worktree sweep refused` means `container_root` is wrong or unset; `git fetch failed` is a remote that is unreachable; `holds the lock` clears by itself. The same message repeating on the hourly retry is not raised again |

A watch that outlives its TTL reports `watch expired before it finished`: register it again.

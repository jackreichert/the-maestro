# Playbook: reset a stalled agent (for the orchestrator)

A `stalled <id> ...` event means the agent on that item has shown no progress (no commit, no edited file in its worktree) for `stall_minutes`. A stalled agent keeps burning context and cost, and a fresh agent that inherits what was learned is cheaper than waiting. The event loop only reports it; stopping and re-dispatching an agent is yours.

## 1. Check it is a real stall

Read the event's evidence, then look once before you act: `git -C <worktree> status --short` and `git -C <worktree> log -3 --format='%h %cr %s'`. Then check the report file: the path `brief` printed (the `report` field of the item's `brief` row). If it exists and is newer than the dispatch, the agent finished and never handed back: read it, take it as the result, and do not re-brief, because the new brief hands out the same path and the fresh agent would overwrite the only copy. The loop says `finished <id>` instead of `stalled <id>` in that case. If the agent is plainly in the middle of something slow (a test run you can see in `ps`, a build), leave it, and say so in one line. Otherwise continue. A wrongly reset agent loses its context; a wrongly spared one only costs another tick.

## 2. Stop the agent

Stop it with the harness (`TaskStop` on the agent, or stop the background task named in the dispatch). Do not delete or reset its worktree: the work on disk is what the fresh agent builds on. If it left uncommitted edits, do not commit them for it; the brief points the new agent at them.

## 3. Write a fresh brief that carries what was learned

Write a details file (in the scripts shelf `scratch/briefs/`) with what the stalled agent established, in a few lines each:

- what is done and verified (commits, passing tests), and what is half-done (files edited but not committed);
- what it was stuck on, and what it tried that did not work, so the new agent does not repeat it;
- the next concrete step, and the command that checks it.

Take it from the worktree and the agent's last output, not from memory. Never paste secrets or personal data. Release the old grant, then brief again with the file:

```bash
node scripts/journal.ts release <repo> --desk <stream> --worktree <worktree name>
node scripts/journal.ts brief <id> --details-file <details file> --worktree <worktree name> --desk <stream> --model ... --used ...
```

`brief` prints the Agent prompt to use and writes a new claim row for the item, which starts the stall clock again. If either command refuses, read why and stop; do not force it.

## 4. Re-dispatch

Dispatch the Agent prompt `brief` printed, in the same worktree, as one writer (see [dispatch](../reference/dispatch.md)). The new agent continues from the branch as it stands.

## 5. Note the reset on the ledger

```bash
node scripts/journal.ts log "reset <id>: stalled <N>m, last sign <evidence>; re-dispatched with a fresh brief (<details file>)" --repo <repo> --ticket <ticket if any>
```

A reset that happens twice on one item is not an agent problem: the item is too big or blocked. Stop, split or ask, instead of a third reset.

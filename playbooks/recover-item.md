# Playbook: recover an in-flight item whose session died (for a cheap runner)

## What this does

When a session ends (compaction, a closed terminal, a roll), the agents it started lose their memory, but their ledger rows remain. This playbook takes one open row, asks the ledger what it knows about it (the brief, the worktree, the branch, the ticket and the recorded next step), checks what state the work is really in, and then hands a fresh agent a complete prompt to carry on. It never edits code, never deletes a worktree and never closes the row; it only reads, then starts one new agent.

## 1. Pick the row

Take `<id>` from the orchestrator. Run `journal.ts status` and confirm the id is listed as open. If it is closed or missing, report `<id> is not open work` and stop.

## 2. Print the recovery prompt

```bash
journal.ts recover <id>
```

It exits 0 and prints the prompt. Exit 1 means the row is closed or unknown: report that and stop. Do not retry.

## 3. Read the three warnings

Look in the output for these lines and note which apply:

- `The worktree is missing` means the directory is gone. The prompt already says to check the branch locally and on origin. Do not create the worktree yourself.
- `not recorded (an older row)` means the row predates recovery fields. The new agent must look for the work itself.
- `none recorded` after `Next step` means nobody recorded a step. The new agent decides it from the commits and the ticket.

## 4. Check that nobody else is on it

Run `journal.ts claims`. If a live claim on the item's repo names a running desk, another agent may still be working: report `<id> may still be running (claim <repo> held by <desk>)` and stop. Do not release anything.

## 5. Re-dispatch

Start one agent with the printed prompt unchanged, as its whole brief. Use the repo-worker agent for a writing task and Explore for a read-only one. Do not shorten or reword the prompt. If the output named a brief file, the agent reads it first.

## 6. Record it

```bash
journal.ts next <id> "re-dispatched, resuming from the recorded state"
```

## 7. Report

Report one line: the id, which warnings from step 3 applied, and that a new agent was started. If any step failed, report the step number and the command's error line instead.

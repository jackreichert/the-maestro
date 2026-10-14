# Playbook: triage the open in-progress ledger rows once (for a cheap runner)

This runbook lists every open in-progress ledger row with its evidence, closes the ones with hard evidence, and puts the rest into one batch question. It is read-only until step 3. You never close a row without evidence or an answer from the user.

## 1. List the rows

```bash
node <scripts_dir>/stale-wip-triage.ts [--tickets-vault <notes vault>] [--vault <ledger root>] [--project <name>]
```

Add `--json` if the orchestrator wants machine output. Exit 0 means it read the ledger; exit 2 means bad arguments, so report the message and stop. The first line is the total: how many rows, how many have hard evidence, how many go to the batch ask.

Each row shows its age, its last touch, its ticket and that ticket's status (with `--tickets-vault`), its children (rows filed with `log --parent <id>`), and any PR references in its text.

## 2. Check the PRs

For every `owner/repo#N` a row lists, follow [pr-state.md](pr-state.md) and note whether it is merged, open or closed. A merged PR is hard evidence; an open one is not.

## 3. Close the hard-evidence rows

A row is hard evidence when the script says `CLOSE` (its ticket is closed, or every child row is closed), or when its only PR is merged. For each one:

```bash
node <scripts_dir>/journal.ts done <id> "closed by triage: <the evidence, e.g. ticket widgets-12 is closed>"
```

Cite the evidence in the text every time. Never close a row the script marks `ASK` unless a PR is merged.

A row that was briefed to an agent is refused by `done` when the agent left no retro. A stale row's agent is gone and cannot write one, so close it with `--no-retro "agent gone, closed by triage"` added to the same command; the reason is recorded and the retro review sees the gap.

## 4. One batch ask

Every remaining row goes into a single message to the orchestrator, one line each: id, age, last touch, and a recommendation (`close`, `drop` or `keep`) with the reason. Do not ask one question per row. Do not apply anything until the answer arrives; then apply `done <id>` for close, `drop <id>` for drop, and `lease <id>` for keep.

## 5. Record the count

Run `node <scripts_dir>/journal.ts status --json` and report how many in-flight rows and stale rows remain. Only live work should be left in progress. The runbook is finished when that count is recorded.

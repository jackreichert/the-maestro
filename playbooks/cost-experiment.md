# Playbook: daily cost experiment (for a cheap runner)

You are the runner. The `cost-experiment` standing pickup is due. You pick one experiment from yesterday's token numbers, write it down, and record that it ran. Work from the skill root. Run each command in the foreground.

## 1. Refresh yesterday's row

```bash
node scripts/token-metrics.ts --date <yesterday, YYYY-MM-DD> --write
```

Skip it when `propose` (step 2) already shows `"hasRow": true` for that date.

## 2. Get the proposal input

```bash
node scripts/cost-experiment.ts propose [--date <yesterday>]
```

| You see | You do |
|---|---|
| `"alreadyProposed": true` | Today's row is there. Go to step 5. |
| `"hasRow": false` | Run the command in `missing` once, then rerun `propose`. Still false: report it and stop. |
| `pick.basis` is `regression` | The metric to work on is `pick.metric`. Step 3. |
| `pick.basis` is `mix` | Nothing regressed; the mix metric furthest from target is `pick.metric`. Step 3. |
| `pick.basis` is `none` | No numbers to work from. Report that and stop; write nothing. |

If `runningOnMetric` lists ids, an experiment on that metric is already running: propose a different practice for the same metric, or the next metric in `pick.regressions`, never a copy.

## 3. Write one proposal

Four short lines, one sentence each, no pipe characters:

- practice: what changes, in a few words;
- hypothesis: why it should move `pick.metric`;
- metric: `pick.metric` (the name exactly as printed);
- threshold: the number that counts as success, judged over 5 working days.

Prefer one of the approved habits in `habits` when it fits (pass its key as `--habit`). Do not invent a habit key.

## 4. Record it

```bash
node scripts/cost-experiment.ts write --date <date> --practice "..." --hypothesis "..." --metric "..." --threshold "..." [--habit <key>]
```

It is safe to run twice: the second run prints `already recorded`. A `proposed` row needs a decision, so raise one ask:

```bash
node scripts/journal.ts ask "Cost experiment cx-<date>: <practice>?" --kind decision --door two-way --recommend "run it for 5 working days" --default "do not start it" --searched "cost-experiment.ts propose output for <date>"
```

This ask is two-way with a `--default`, so it is acted on as a note and is exempt from the ask template; any ask the user must see needs the template (`reference/ledger.md`).

Skip the ask for a `running` row (an approved habit).

## 5. Record the run

```bash
node scripts/journal.ts standing done cost-experiment --evidence "cx-<date> <added as proposed|running|already recorded>"
```

## Report

At most 6 lines: the date, `pick.basis` and `pick.metric` with its numbers, the id and status of the row, the ask id when you raised one.

## Hard rules

- One proposal a day. Never edit another row of the registry, never change a status, never write a result.
- Never start the experiment yourself. A `running` row means an approved habit that is already the rule; the loop measures it.
- Do not read or print transcripts. Use only the commands above.

# The self-correcting loop

Read this before the EOD standup's cost section, before touching the experiment registry, and
before proposing or applying any cost habit. It runs once, right after the cost line in
[measure.md](measure.md), from `reference/ledger.md`'s end-of-day sequence.

The idea, approved by the user 2026-09-25: measure every day, run each cost habit as a stated
experiment, and let the EOD routine decide what is adopted and what is reverted, from real numbers
rather than a guess.

## The loop, run at EOD

1. **Measure.** `VAULT_ROOT=... node scripts/token-metrics.ts --write --compare` — see
   [measure.md](measure.md). Read the printed summary.
2. **Compare.** Note any key metric (turns, wake-ups, cache read, read/turn, avg report) that moved
   more than ~20% against the 7-day median — the script marks these `REGRESSION >20%`.
3. **Check the running experiments**, against the registry in the vault
   (`Research/token-usage-strategies.md#self-correcting-loop`, under
   `$VAULT_ROOT/Projects/<container-name>/`). For each row with status `running`, compare its
   metric against its stated success threshold. Passed → mark `adopted` and propose the permanent
   skill edit. Clearly failed → mark `reverted` and propose undoing it. Otherwise leave it
   `running`. Update the registry row's result cell in place; thresholds are judged over 5 working
   days unless the row says otherwise.
4. **Explain regressions.** For each flagged metric, name the likely cause from today's ledger and
   the per-session table — a long session, a background watcher, an Opus-heavy fan-out, a
   rehearsal.
5. **Propose.** Put one or two adjustments in the standup, under the cost line. Also flag if the
   live session is past the roll threshold in [budget.md](budget.md#session-hygiene).

## Experiment statuses

`proposed → running → adopted | reverted`, tracked one row per experiment in the vault registry.
`running` means the practice is in effect and being measured; the loop above is what moves a row
out of `running`. Nothing skips `running` — even a practice the user is confident in gets measured
before it's called `adopted`.

## Proposed, not applied

Changes to skills or memory that come out of the loop go to the user as **proposals**, not silent
edits — the loop finds things, it doesn't rewrite the skill on its own. The only exception is the
handful of habits the user already approved on 2026-09-25, which apply without asking each time:
the standing brief block, foreground waits, capped reports, lean tool output, Haiku routing for
verifiable gathering, and session hygiene (all detailed in [budget.md](budget.md)).

## Weekly review

On the last working day of the week, add one line to the standup: what was adopted, what was
reverted, and the week's trend in cache read and wake-ups. Record the same line under the
registry's own weekly-log table in the vault.

## Worked example, 2026-09-27

The day's numbers (`token-metrics.ts --compare`, cost line in [measure.md](measure.md)) closed the
loop with a concrete regression and a concrete fix, not just a rule restated:

- Wake-ups ran **+16%** against the recent trend, traced to a PR watcher polling every 2 minutes
  instead of the standard cadence — see [budget.md#pr-watcher-cadence](budget.md#pr-watcher-cadence)
  for the resulting rule.
- Read/turn ran **+13%**, traced to a session that reached 316 turns without being rolled — past
  the roll thresholds in [budget.md#session-hygiene](budget.md#session-hygiene).
- Proposed adjustment, folded into the standing habits rather than left as a one-off: batch
  bot-thread review rounds per repo (one pass handles every open bot thread in a repo) instead of
  dispatching a fresh agent per wake-up — see
  [budget.md#choosing-the-agent](budget.md#choosing-the-agent).

This is the loop working as designed: a regression with a named cause, and a rule tightened because
of it, not a habit adopted on faith.

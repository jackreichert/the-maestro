---
name: cost-control
description: Token-cost measurement and control for the-maestro. Load when running the EOD cost line/loop, choosing an agent or model tier, a session is getting long, tuning the PR watcher's cadence, answering "how much did today cost", or running or evaluating a token experiment.
---

# Cost control

**Load when** the task is the EOD cost line or cost loop, choosing an agent or a model tier, a
session getting long, the PR watcher's cadence, "how much did today cost", or running or
evaluating a token experiment. Otherwise the generic the-maestro files are enough.

Everything cost-specific in the-maestro lives in this folder, and only here. The generic files
(`reference/ledger.md`, `reference/dispatch.md`) state the surrounding process and point here for
the cost content. Read only the file the task needs:

| File | Holds |
|---|---|
| [measure.md](measure.md) | The daily cost line (`ccusage`) and `token-metrics.ts`: what it measures, how to run it, and how to read its output. This is also the answer to "how much did today cost". |
| [loop.md](loop.md) | The self-correcting loop run at EOD: compare today against the baseline and the 7-day median, the >20% regression flag, the experiment registry's statuses (proposed / running / adopted / reverted), what gets proposed versus applied without asking, and the weekly review line. |
| [budget.md](budget.md) | Model tiers and agent choice, the standing brief's cost habits (foreground waits, capped reports, lean tool output), session hygiene (the ~200-turn roll), and the PR watcher's cadence. |

The experiment registry, the daily metrics table, and their full history stay in the vault — this
folder holds the rules and how to run them, not the data itself:

- `Research/token-usage-strategies.md#self-correcting-loop` — the experiment registry, thresholds,
  and dated results, under `$VAULT_ROOT/Projects/<container-name>/`.
- `Research/token-metrics.md` — the daily table `token-metrics.ts --write` maintains, same location.

## Where this folder is going

Team-shareable, same as the rest of `reference/*.md` — nothing here names a person's paths or an
org. Values (vault root, transcript dir) come from `../reference/local-config.md`, same as
everywhere else in this skill.

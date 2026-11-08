---
name: retro
description: "Use on request for retrospectives, cost or recovery improvement, plugin experiments, memory integrity, and approval-gated cleanup."
disable-model-invocation: true
---

# Retro

On demand only, including weekly reviews. No scheduler, watcher, Stop/PreCompact retro, or mandatory extra agent. Plugins are selectively loaded review modules, not agents.

## Run a bounded review

1. Confirm scope/window/plugins; reuse prior results, avoid double-counting. Resolve vault via [settings](../README.md#settings) and repo: `Projects/<repo>/Research/Retros/`; cross-repo reviews use an agreed workspace project.
2. Compare outcomes with commitments/acceptance criteria; distinguish implemented/reviewed/merged/tested/deployed. Check blocked/carried/retired work and review misses; verify evidence, not confident reports.
3. Load selected eligible registry modules within scope/budget. Batch collection; deterministic checks before analysis. Missing evidence stays unknown.
4. Deduplicate lessons: verified knowledge → library; outcomes/rationale → ledger; work → tickets; working rules → proposals. Existing-rule misses need recall/execution investigation before more text.
5. Report verdict, risks, trends/limits, learning destinations, cleanup/keep reasons, and at most two improvements with owners/revisit triggers. Record dispositions; no retro-review chain.

## Plugin lifecycle

- Registry: `Projects/<project>/Research/Retros/Plugins.md`, linked experiment details beside it. Fields: ID/module/state/goal, scope/evidence, baseline, cadence/trigger, budget, success threshold/quality floor, owner/review date, exit/reopen conditions.
- States: proposed → active → monitoring → closed; rejection closes with rationale. Cadence is eligibility during an invoked review, not scheduling. Closed modules stay unloaded; monitoring checks cheaply, investigating threshold breaches only.
- Experiments: proposed → running → adopted/reverted. Agree baseline/comparable workload, observation period, threshold, quality guardrail, rollback before running. Inconclusive results continue within budget or return for a decision.
- Propose changes to the owning core; apply only approved changes. Close after sustained agreed success, recorded results/rationale, adopted changes, reopening trigger. Preserve history; long-running monitoring is valid.

## Starter modules

- [Recovery](./plugins/recovery.md): continuity, library usefulness, integrity/backup.
- [Cost](./plugins/cost.md): efficiency with quality guardrails.
- [Cleanup](./plugins/cleanup.md): optional approved reclamation.

Modules are available, not active by default; new plugins use this contract. Draft only: no scripts, live registry, experiments, or cleanup installed.

# Event type: spend-watch

Reports when Claude spend crosses the budget guardrail. Script: [scripts/event-types/spend-watch.ts](../../scripts/event-types/spend-watch.ts). Target is the status directory (any existing directory). Off unless `budget_monthly_usd` is set; `session-start.ts` registers it only then: `node scripts/event-loop.ts add --id spend-watch --type spend-watch --target <status dir>`. It checks every 15 minutes, renews itself, and notifies through `notify_command` unless added with `--no-notify`. No model is involved.

## What it watches

Spend since the budget period started, from `npx ccusage daily --json` (cached 15 minutes). **ccusage reads this machine's transcripts only, so every figure is this machine's.** It is also an estimate: `budget_cost_multiplier` scales it toward the real bill (long-context turns over 200k input tokens bill at a premium that ccusage under-counts). **The authoritative number is the Console cost for the API key.**

The daily allowance is the monthly budget divided by the budget days in the period (the start day to the day before the next one; weekdays only in `weekdays` mode). Today is judged against it; the period against allowance times budget days elapsed (the pace). Spend on a non-budget day has no allowance, so it is over.

## What the loop reports

Each line is actionable and said once per threshold per day.

| Line | Meaning |
|---|---|
| `spend-watch WARN: ...` | Today is at or past `budget_warn_fraction` of the daily allowance. |
| `spend-watch HARD: ...` | Today is at or past `budget_hard_fraction` of it. |
| `spend-watch PACE: ...` | The period total is over the pace. |
| `spend-watch: $X today on a day that is not a budget day` | Any spend on a weekend (in `weekdays` mode). |

## What you do

- **WARN:** tell Jack the line, and stop dispatching agents. Finish only what is already running.
- **HARD:** tell Jack the line, and do only what he explicitly asks, one thing at a time.
- **PACE** or a non-budget day: tell Jack; treat it as WARN until he says otherwise.

An unreadable figure is silent here; the footer's `Spend:` segment says `unavailable (reason)`.

# Measure

How to answer "how much did today cost", and what feeds the rest of `cost/`. Read this before
running either command below for the first time in a session; after that, running them is cheap
enough to just do.

## The cost line

Run `npx ccusage daily --since <today YYYYMMDD>` once, and put one line at the end of the standup:
total $, the split by model, and cache-read tokens against fresh input. Compare it with the
previous working day if that day's standup has a cost line. This is the only `ccusage` call of the
day — don't repeat it per reply, and don't add it to the per-reply status footer (that would cut
against the batching habit in [loop.md](loop.md), for a marginal visibility gain over once/day).

Worked example, 2026-09-27: the day closed at **$171.01**, against **~$236** the day before. That
comparison is the whole point of running the line daily rather than trusting a gut feel — the drop
tracks the day's actual work volume, not a habit change, and the loop below is what checks whether
any of that change is a regression worth explaining.

## `token-metrics.mjs`

The script behind the cost loop and the daily table. It reads Claude Code's local transcripts —
usage numbers, model ids, timestamps, and message type/role/origin metadata only, never message
content — and never touches the vault except to upsert its own table.

```bash
VAULT_ROOT=... node scripts/token-metrics.mjs --write --compare   # today's row + comparison
node scripts/token-metrics.mjs                                    # today, printed, no vault write
node scripts/token-metrics.mjs --date 2026-09-25                  # a specific day
node scripts/token-metrics.mjs --all --write                      # backfill every day still on disk
node scripts/token-metrics.mjs --curve                            # cache-read per turn, by turn-index bucket
node scripts/token-metrics.mjs --json                              # machine-readable day + sessions
```

- `--write` upserts today's row into `Research/token-metrics.md` (idempotent — rerunning a day
  replaces its row, so it's safe to call more than once). `--all --write` backfills every day still
  on disk, which matters because Claude Code prunes old transcripts and the vault table is the only
  durable history past that point.
- `--compare` prints today against the 7-day median and the pre-habits baseline (median of
  2026-09-17 through 2026-09-24) for nine core metrics (turns, wake-ups, output, cache read, read/turn,
  read/prompt, read/subagent, avg report, sub growth) plus the cost metrics below. Any metric that moved more than ~20% against
  the 7-day median is flagged `REGRESSION >20%` — the trigger for [loop.md](loop.md) step 2.
- The day summary and `--compare` also score the cost metrics (model mix, wake-ups per prompt, read per
  turn, max turns since compact, small-agent rate, Opus subagents) against `cost_targets`, with PASS or
  MISS; the model mix is also shown by price when `model_price_weights` is set. Keys and targets are in the
  README. Rework rate and corrections are ledger notes, not transcript metrics.
- Read the printed summary, not the table file — the table is for history and for the script's own
  `--compare`, not for a human to scan by eye.
- Tests: `scripts/token-metrics.test.mjs`. A planted-sentinel test asserts message content never
  reaches stdout or the vault file, enforcing the content-safety claim above at runtime, not just in
  the comment.

Full field definitions (a turn, a wake-up, report size, the session-length curve that sets the roll
threshold) are in the script's own header comment — read that before changing its output shape.

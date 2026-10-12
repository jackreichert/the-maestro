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

That comparison is the whole point of running the line daily rather than trusting a gut feel: a
change tracks the day's actual work volume or a habit change, and the loop below is what checks
whether it is a regression worth explaining.

## `token-metrics.ts`

The script behind the cost loop and the daily table. It reads Claude Code's local transcripts —
usage numbers, model ids, timestamps, and message type/role/origin metadata only, never message
content — and never touches the vault except to upsert its own table.

```bash
VAULT_ROOT=... node scripts/token-metrics.ts --write --compare   # today's row + comparison
node scripts/token-metrics.ts                                    # today, printed, no vault write
node scripts/token-metrics.ts --date 2026-09-25                  # a specific day
node scripts/token-metrics.ts --all --write                      # backfill every day still on disk
node scripts/token-metrics.ts --curve                            # cache-read per turn, by turn-index bucket
node scripts/token-metrics.ts --expiry                            # cache-expiry rewrites per day: count, average gap, dollars
node scripts/token-metrics.ts --leaks                             # avoidable spend by bucket, ranked, with the fix for each
node scripts/token-metrics.ts --json                              # machine-readable day + sessions
```

- `--write` upserts today's row into `Research/token-metrics.md` (idempotent — rerunning a day
  replaces its row, so it's safe to call more than once). `--all --write` backfills every day still
  on disk, which matters because Claude Code prunes old transcripts and the vault table is the only
  durable history past that point.
- `--compare` prints today against the 7-day median and the pre-habits baseline (median up to
  `--baseline-until`, default 2026-09-24) for nine core metrics (turns, wake-ups, output, cache read, read/turn,
  read/prompt, read/subagent, avg report, sub growth) plus the cost metrics below. Any metric that moved more than ~20% against
  the 7-day median is flagged `REGRESSION >20%` — the trigger for [loop.md](loop.md) step 2.
- The day summary and `--compare` also score the cost metrics (model mix, wake-ups per prompt, read per
  turn, max turns since compact, small-agent rate, Opus subagents) against `cost_targets`, with PASS or
  MISS; when `model_prices` is set the day summary also shows estimated dollars per day (orchestrator and
  subagents, by model and by category), the model mix by price, and a what-if line pricing the orchestrator's
  tokens at Sonnet rates (informational: it ignores quality). Keys, targets and the default prices are in the
  README. Rework rate and corrections are ledger notes, not transcript metrics.
- Cache-expiry rewrites: a turn more than 5 minutes after the previous turn in the same transcript that
  writes at least 30k tokens to the 5-minute cache, so the prompt cache had lapsed and the whole context
  was written again. The day summary prints the count, average gap and dollars by model; `--expiry`
  lists every day; `--compare` carries "Est. $ cache expiry" and "Expiry rewrites". Subagent
  transcripts count. The fix is to never wait on a suite: see [budget.md](budget.md).
- `--leaks` replays every transcript on disk under one change per bucket and prints the dollars each would
  have avoided, most first, with a fix line. It needs `model_prices` (no prices are built in) and says so
  when they are unset. The figures are counterfactuals on the same tokens, not billed amounts, and a bucket
  that would cost more than it saves is left out. The buckets:
  - **Read-only subagents on a dearer model**: runs whose every tool call was read-only (judged by the tools
    actually called; a Bash call counts when the command only reads), repriced at Haiku, by agent type.
  - **Subagent cache on a 1h TTL**: every 5m write priced at the 1h write price, and each expiry rewrite after
    a gap of at most an hour turned into a cache read. Reported as the net.
  - **Compaction at the roll threshold**: orchestrator sessions replayed with the context dropping to about 55k
    each time it passes the roll-now percent of the autocompact trigger, net of writing the new base.
  - **Huge tool results**: a result of about 2k tokens or more (characters / 4; the threshold sits under the roughly 7.5k-token cap the harness puts on Bash output, so Bash results count) times the cache-read price of every
    later turn until the next compaction, by tool name and file basename. The result text is never read.
- Dedupe: a turn is one API response, counted once by `message.id` within a transcript, so the one line per content block
  Claude Code writes does not multiply it. `requestId` is not part of the key: it never differed for one id in the local transcripts.
  An id can repeat across session files when a session is resumed; that is not deduplicated.
- Read the printed summary, not the table file — the table is for history and for the script's own
  `--compare`, not for a human to scan by eye.
- Tests: `scripts/token-metrics.test.ts`. A planted-sentinel test asserts message content never
  reaches stdout or the vault file, enforcing the content-safety claim above at runtime, not just in
  the comment.

Full field definitions (a turn, a wake-up, report size, the session-length curve that sets the roll
threshold) are in the script's own header comment — read that before changing its output shape.

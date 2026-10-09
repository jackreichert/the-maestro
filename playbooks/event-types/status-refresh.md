# Event type: status-refresh

Regenerates the Podium (`The-Podium.md`) inside the event loop, with no model and no orchestrator turn. Script: [scripts/event-types/status-refresh.ts](../../scripts/event-types/status-refresh.ts). Target is the status directory, the folder holding `The-Podium.md` (the `status_dir` setting, else `<vault_root>/Projects/<project>/Status`).

Register: `node scripts/event-loop.ts add --id status-refresh --type status-refresh --target <status dir> --ttl-hours 72`. One watch only. It never sends a notification and a refresh never ends `event-loop.ts run` with exit 10: its events are never actionable and a check never throws. The one exception is the loop's own expiry notice (below).

## What triggers a regeneration

| Trigger | Rule |
|---|---|
| A ledger write (`ledger.jsonl`, the stream registry or `priorities.md` changed) | Wait until the files have been quiet for 15 s, and never more than 60 s after the first change, so a burst of writes gives one regeneration |
| `pr-watch` or `pr-merged` reported something | They touch `.now-dirty-prs` in the status directory; same debounce, and the GitHub read is refreshed |
| The idle tick | 10 minutes since the last regeneration, so the freshness line stays true |

The GitHub read runs only when the PR data is dirty or more than 5 minutes old; otherwise the page renders the cached PR set (`.now-prs.json`). In quiet hours it is skipped altogether: the page is rebuilt from the ledger and the cached PRs, and the PR data stays dirty until the next waking-hours refresh. With `watch_quiet_hours_mode: slow` the watch keeps running overnight at 1800 s; in `stop` mode the loop itself stops.

## The current PR board

The footer's review queue reads whichever of `prs-snapshot.json` (written only by the greeting's `prs-snapshot.ts`) and `prs-current.json` is newer. On the idle tick this watch refreshes `prs-current.json`: when the newest `takenAt` of the two is more than 10 minutes old (a snapshot the greeting just took counts), it runs one GitHub search, the same query as `prs-snapshot.ts`, and rewrites `prs-current.json` by rename. No per-PR calls, so the after-merge `mergeable` re-asks stay with the greeting's run. Never in quiet hours, and a search that hangs is cut off after 60 s. The refresh never touches `prs-snapshot.ts --diff`'s baseline, so the greeting diff still reports everything since the last greeting.

## Never over your own edit

While `The-Podium.md` holds an edit the status watcher has not adopted yet and that was saved under 60 s ago, nothing is written. The refresh stays pending and runs once the window has passed.

## What the loop reports

Nothing, normally. If a regeneration fails (the ledger cannot be read, or another rebuild holds `.now.lock`) it is retried after 2 minutes and one informational line says why: `status page refresh failed: <reason>`. It is not actionable: do nothing unless the same line keeps coming back, then run `node scripts/journal.ts status-page` by hand to see the full error.

If the snapshot search fails (gh missing, signed out or rate limited) it is retried after 10 minutes and one informational line says why: `PR snapshot refresh failed: <reason>`. The old files stay, and the footer keeps flagging its age.

A watch that outlives its TTL reports `watch expired before it finished`: register it again.

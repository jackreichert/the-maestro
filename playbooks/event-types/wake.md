# Event type: wake

## What this does

A wake is a durable alarm for the orchestrator. You say when (one time, or every hour at chosen minutes) and what to do, and the event loop, which keeps running when your session does not, puts a line in the digest when the time comes. A waiting `digest-wait` then wakes an idle session at no token cost. Use it instead of a session-only cron, which dies at a roll or when the terminal closes. Script: [scripts/event-types/wake.ts](../../scripts/event-types/wake.ts). The check reads the clock only; it never touches the network and never sends a text.

Register one time: `node scripts/event-loop.ts add --id wake-<n> --type wake --target <ISO 8601 UTC time> --report "<what to do at that time>"`. `add` refuses a malformed or past target. The watch retires after it fires.

Register a recurring wake: `node scripts/event-loop.ts add --id wake-hourly --type wake --target hourly:7,37 --report "<the queue to work>"`. The minutes are past every hour, UTC. It lives until its TTL (24 hours unless you pass `--ttl-hours`), so re-add it at roll.

Quiet hours hold a wake until they end; add `--notify-overnight` to fire through the night. Slots that pass while it is held, or while the loop is down, fold into one event that says how many passed.

## What the loop reports

| Digest line | Actionable? | What to report |
|---|---|---|
| `wake: <text>` | yes | Do what the text says. A recurring wake's first check only records where it is; it does not fire. |
| `wake: <text> (N wake times passed)` | yes | The same, once. Several slots passed unseen (quiet hours, a loop outage), so do the work once, not N times. |

## Notifications

A wake never notifies, whatever the watch's flags say. `--notify` is refused at `add`.

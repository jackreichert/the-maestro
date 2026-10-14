# Event type: reminder

Wakes the orchestrator at a set time, once or on a recurring local schedule. Script: [scripts/event-types/reminder.ts](../../scripts/event-types/reminder.ts). The check reads the clock only; it never touches the network.

Register: `node scripts/event-loop.ts add --id remind-<n> --type reminder --target <ISO 8601 UTC time> --report "<what to do or say at that time>"`, for example `--target 2026-10-03T15:00:00Z`. `add` refuses a malformed target or one already in the past. Register a recurring reminder: `--target 'weekdays@08:30 America/New_York'` (Monday to Friday) or `--target 'daily@08:30 America/New_York'`. The time is the wall clock in that IANA zone, so it holds across a daylight-saving change. It fires at most once per matching local day, then waits for the next; it does not retire, and its lifetime renews (7 days, pushed out again when under half is left) unless you pass `--ttl-hours`. If the loop was down at the set time, one catch-up fires when it returns the same day; days missed entirely are not replayed. A watch added after today's time waits for the next matching day. `add` refuses an unknown zone or a time outside 00:00-23:59.

Quiet hours hold it until morning; add `--notify-overnight` to fire through the night.

## What the loop reports

| Digest line | Actionable? | What to report |
|---|---|---|
| `reminder: <text>` | yes | The reminder text, once. A one-time reminder retires after this line and does not repeat; a recurring one stays and fires again on its next day (a crash at the wrong moment can deliver the line twice, never zero times). |

## Notifications

A reminder notifies by default when the install has a `notify_command`; `--no-notify` at `add` turns that off.

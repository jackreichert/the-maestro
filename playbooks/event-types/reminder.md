# Event type: reminder

Wakes the orchestrator once at a set time. Script: [scripts/event-types/reminder.mjs](../../scripts/event-types/reminder.mjs). The check reads the clock only; it never touches the network.

Register: `node scripts/event-loop.mjs add --id remind-<n> --type reminder --target <ISO 8601 UTC time> --report "<what to do or say at that time>"`, for example `--target 2026-10-03T15:00:00Z`. `add` refuses a malformed target or one already in the past. Quiet hours hold it until morning; add `--notify-overnight` to fire through the night.

## What the loop reports

| Digest line | Actionable? | What to report |
|---|---|---|
| `reminder: <text>` | yes | The reminder text, once. The watch retires after this line and does not repeat (a crash at the wrong moment can deliver the line twice, never zero times). |

## Notifications

A reminder notifies by default when the install has a `notify_command`; `--no-notify` at `add` turns that off.

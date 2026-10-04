# Event type: inbox

New messages from the user. Script: [scripts/event-types/inbox.ts](../../scripts/event-types/inbox.ts). The command it runs is the `inbox_command` local-config setting (an argv array printing one line per unread message); without it the check fails and the loop says so after three failures.

Register: `node scripts/event-loop.ts add --id inbox --type inbox --target inbox --notify-overnight --ttl-hours 12`. Leave `--notify-overnight` off to ignore messages in quiet hours. The inbox never sends a notification, even with `--notify` (it is refused at `add`).

## What the loop reports

| Digest line | Actionable? | What to report |
|---|---|---|
| `N new message(s) from user` | yes | That N messages arrived. Nothing else. |

## Privacy

Message text is personal data. The type keeps only a hash of each line and the digest holds only the count. **Never** run the inbox command yourself to quote a message, and never put message text in the report, a notification, the ledger or a log. The orchestrator reads the messages itself.

The inbox command must not mark messages as read; if it does, the orchestrator will find nothing to read.

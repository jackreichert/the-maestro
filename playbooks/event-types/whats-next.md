# Event type: whats-next

Keeps the ranked queue (`journal.ts next`) current without anyone remembering to look. Script: [scripts/event-types/whats-next.ts](../../scripts/event-types/whats-next.ts). Target is the status directory (where the tracker snapshot, `tracker-items.json`, lives). One watch.

Register: `node scripts/event-loop.ts add --id whats-next --type whats-next --target <status dir>`. `session-start.ts` registers it. It checks every 300 seconds, never leaves the machine, renews itself like the other standing watches, and does not notify unless added with `--notify`.

## What it watches

Each tick ranks the queue the same way `journal.ts next` does and keeps the top item and the time the tracker snapshot was fetched. A snapshot older than 6 hours is stale; it is announced once per snapshot, so a fresh `tracker-import` resets it. No snapshot at all is silence: an install that tracks nothing outside the vault is never nagged. The first check only records the top item; after that, a change of top item is reported once.

## What the loop reports

| Digest line | Actionable | What to report |
|---|---|---|
| `whats-next: the tracker snapshot is Nh old; refresh it (playbooks/tracker-snapshot.md)` | yes | Run [playbooks/tracker-snapshot.md](../tracker-snapshot.md) (a cheap model is enough), then report the import's count line. |
| `whats-next: top of the queue is now <id> (<title>)` | no | Mention it in the next digest; `journal.ts next` shows the score and why. |
| `whats-next: nothing is ready now (journal.ts next --all says why)` | no | Mention it; `journal.ts next --all` lists what is held back. |

## What you do

Refresh the snapshot when asked, and otherwise only report. You never pick up the top item on the strength of this line, never change a ticket's status, and never write to the tracker.

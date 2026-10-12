# Event type: status-watch

The user's inline edits to the Podium (the status page). Script: [scripts/event-types/status-watch.ts](../../scripts/event-types/status-watch.ts). Target is the status directory, the folder holding `The-Podium.md` (the `status_dir` setting, else `<vault_root>/Projects/<project>/Status`).

Register: `node scripts/event-loop.ts add --id status-watch --type status-watch --target <status dir> --ttl-hours 72`. One watch only. It never sends a notification: the edit is the user's own.

## What the user can write

| Edit in The-Podium.md | Meaning |
|---|---|
| `> answer: <text>` under an ask line (`- [ ] \`id\` ...`) | The answer to that ask |
| `> discuss: <topic>` under an ask line (the topic may be empty) | The user wants to talk this ask through in chat before anything is done about it |
| `- [x]` on an ask line | The user marks the ask done or approved |
| Changed lines under `## Today's priorities` | New priorities |

## What the loop reports

| Digest line | Actionable? | What to do |
|---|---|---|
| `ask <id> (decision: <ask text>) answered: <text>` | yes | Treat the text as the user's answer to ask `<id>`: act on it, then (check first with `journal.ts query --id <id>` that the ask is still open: a page answer given on the web reads like this plain line when the watcher cannot see the web server's ledger, and `resolve` does not refuse a closed ask) `journal.ts resolve <id> --answer "<text>"` |
| `ask <id> (decision: <ask text>) answered on the page, already recorded and closed: <text>` | yes | The user answered with the page's buttons (Send answer, Take recommendation or Skip). The ask is already closed in the ledger with this text, so do **not** run `resolve` again: act on the answer (a Skip means nothing is wanted: say so and move on), then note what you did in the ask's stream with `journal.ts` (a `done` row or the next step's row). It is raised once, by the watcher, never for an answer you recorded yourself with `resolve` |
| `DISCUSS ask <id> (decision: ...): <topic>` (or `(no topic given)`) | yes | Open your next reply with the topic and the ask's context, and do not act on that ask until the chat settles. Then `journal.ts resolve <id> --answer "<what was decided>"`. It never sends a text: the edit is the user's own |
| `ask <id> (decision: ...) ticked` | yes | The user closed or approved it without words; read the ask, do what a tick means for it, then resolve it |
| `priorities edited inline: 1) ...; 2) ...` | yes | Run `journal.ts priorities set "<p1>" "<p2>"` with those lines (a `| Stream` suffix is kept; pass it through) so `priorities.md` matches, then regenerate the page |

An edit is reported once the page has been unchanged for 20 seconds (the type checks every 30), so a half-typed answer is never the one you see.

The digest cuts a line at 300 characters. If an answer line ends in `...`, read the full text under that ask id in `.now-seen.md` (read only) before resolving.

Each answer, tick and discuss mark is also written to the ledger before the event is raised, as an `answer` or `discuss` row on its ask (`journal.ts answer <id> --text "..."` and `journal.ts discuss <id>` write the same rows by hand, for a decision made in chat). The ask stays open for `resolve`, and the page shows the recorded answer under it, so it survives a regeneration even if this session ends before you act on it. If you act on an answer, you do not need to write it down again.

After handling, run `node scripts/journal.ts podium` so the answered rows leave the page.

## How regeneration stays safe

The generator copies an edit the watcher has not reported yet into the page it writes, so regenerating never erases it. The watcher moves its baseline (`.now-seen.md`) to the page as soon as it has reported, and recognises the generator's own output by hash (`.now-seen.json`), so a regeneration never produces an event. Do not edit either file.

If `podium` (alias `status-page`) stops with "a status page refresh is already running", another rebuild holds `.now.lock`: wait a moment and run it again (a lock left by a crashed run is taken over on its own). If it prints "GitHub read failed", the page was still written from the cached PR data under a warning; the answered rows have left it all the same.

The ledger rows are written only when the status directory is the configured project's own, so an answer never lands in another project's ledger. If the write fails the baseline does not move and the edit is found again on the next check.

An answer for an ask that has since left the board is kept under `## Unprocessed answers` at the foot of the page until it is reported.

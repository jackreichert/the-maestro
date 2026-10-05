# Event type: status-watch

The user's inline edits to the Podium (the status page). Script: [scripts/event-types/status-watch.ts](../../scripts/event-types/status-watch.ts). Target is the status directory, the folder holding `The-Podium.md` (the `status_dir` setting, else `<vault_root>/Projects/<project>/Status`).

Register: `node scripts/event-loop.ts add --id status-watch --type status-watch --target <status dir> --ttl-hours 72`. One watch only. It never sends a notification: the edit is the user's own.

## What the user can write

| Edit in The-Podium.md | Meaning |
|---|---|
| `> answer: <text>` under an ask line (`- [ ] \`id\` ...`) | The answer to that ask |
| `- [x]` on an ask line | The user marks the ask done or approved |
| Changed lines under `## Today's priorities` | New priorities |

## What the loop reports

| Digest line | Actionable? | What to do |
|---|---|---|
| `ask <id> (decision: <ask text>) answered: <text>` | yes | Treat the text as the user's answer to ask `<id>`: act on it, then `journal.ts resolve <id> --answer "<text>"` |
| `ask <id> (decision: ...) ticked` | yes | The user closed or approved it without words; read the ask, do what a tick means for it, then resolve it |
| `priorities edited inline: 1) ...; 2) ...` | yes | Run `journal.ts priorities set "<p1>" "<p2>"` with those lines (a `| Stream` suffix is kept; pass it through) so `priorities.md` matches, then regenerate the page |

The digest cuts a line at 300 characters. If an answer line ends in `...`, read the full text under that ask id in `.now-seen.md` (read only) before resolving.

After handling, run `node scripts/journal.ts podium` so the answered rows leave the page.

## How regeneration stays safe

The generator copies an edit the watcher has not reported yet into the page it writes, so regenerating never erases it. The watcher moves its baseline (`.now-seen.md`) to the page as soon as it has reported, and recognises the generator's own output by hash (`.now-seen.json`), so a regeneration never produces an event. Do not edit either file.

If `podium` (alias `status-page`) stops with "a status page refresh is already running", another rebuild holds `.now.lock`: wait a moment and run it again (a lock left by a crashed run is taken over on its own). If it prints "GitHub read failed", the page was still written from the cached PR data under a warning; the answered rows have left it all the same.

An answer for an ask that has since left the board is kept under `## Unprocessed answers` at the foot of the page until it is reported.

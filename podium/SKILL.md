---
name: podium
description: The Podium, the-maestro's always-current status page. Load when the user mentions the Podium or the status page, asks what is on it, leaves an answer, tick or priorities edit on it, asks why it is stale, or asks about the Podium link in the reply footer.
---

# The Podium

**Load when** the task touches the Podium: reading or explaining the page, handling something the
user wrote on it, regenerating it, or the `Podium:` link at the foot of a reply. Otherwise the
generic the-maestro files are enough.

The Podium is one Markdown note, `The-Podium.md`, in the status directory (`status_dir`, else
`<vault_root>/Projects/<project>/Status`). It is regenerated from the ledger and GitHub and is the
primary surface for the user to see the board and answer asks. Side chats with the orchestrator are
for clarity and deeper conversation. `NOW.md` beside it is only a pointer note to the Podium, kept
so old links and bookmarks work. `status-page` is an older name of the `podium` command and still
works. Full reference: [README.md#status-pagets](../README.md#status-pagets).

## Regenerate

`node scripts/journal.ts podium [--snapshot] [--dry-run] [--status-dir <dir>]`. `--dry-run` prints
the page and writes nothing; `--snapshot` also writes a dated copy. One rebuild runs at a time (a
lock in the status directory); "a status page refresh is already running" means wait a moment and
run again. A failed GitHub read still writes the page from cached PR data under a warning.

## Layout, top to bottom

1. **Freshness line**: `Updated <time> · PR data <time>`. Two times, because the ledger and GitHub
   age separately. The PR time carries its date when it is from an earlier day, and reads
   `PR data unavailable` when GitHub has never been read. A stale PR time with no warning means the
   refresh watcher is not running (see below).
2. **Today's priorities**: from `priorities.md`, each with its stream's awaiting, in-flight and
   open-PR counts when it names a stream. Unset reads "Priorities not set for today".
3. **Working on now**: in-flight ledger items grouped by stream, with age.
4. **Needs attention now**: grouped by stream, one list item per ask (id, the decision needed in
   bold, context, ticket and PR links), with its `> answer:` stub on the line directly under it.
   The ask is shown in full, never clipped.
5. **Open PRs**: one table per stream (ticket, develop PR and base, staging twin, tl;dr) and a
   stack diagram.
6. **Other status and findings**: in flight, blocked, recent done, deferred.
7. **Status**: the reply footer unrolled, one row per stream, an agents line and the session line.

## What the user can write on it

Only the asks and the priorities are editable; everything else is regenerated and typing there is
ignored.

| Edit | Meaning |
|---|---|
| `> answer: <text>` under an ask line | The answer to that ask. `> answer <id>: <text>` names the ask wherever it stands |
| `- [x]` on an ask line | The ask is done or approved with no words |
| Changed lines under `## Today's priorities` | New priorities (a ` \| Stream` suffix is kept) |

The `status-watch` event type reports each edit once; handle it per
[playbooks/event-types/status-watch.md](../playbooks/event-types/status-watch.md) (act, then
`journal.ts resolve <id> --answer "<text>"`, or `journal.ts priorities set ...`), then regenerate
so answered rows leave the page. Regenerating never erases an unreported edit: it is carried into
the new page, and an answer whose ask left the board moves under `## Unprocessed answers`.

`> discuss:` and `> drop as planned` lines are not parsed by the watcher: it reports only
`> answer:` lines, ticks and priorities. Treat them as plain notes the user left for the next time
the page is read, and if one matters, answer it in the reply or ask the user to use `> answer:`.

## Keeping it fresh

Register one watch and the page rebuilds itself, with no model:
`node scripts/event-loop.ts add --id podium-refresh --type status-refresh --target <status dir> --ttl-hours 72`
(playbook: [status-refresh.md](../playbooks/event-types/status-refresh.md)). It regenerates after
the ledger has been quiet 15 s, after a PR event, and at least every 10 minutes; it reads GitHub
only when the PR data is dirty or over 5 minutes old, never in quiet hours, and never within 60 s of
the user's own edit. Also register `status-watch` (target the same directory) so edits reach you.
Both watches expire after their TTL; if the freshness line is old, check the loop's registry first.

## The footer link

When `status_dir` sits inside `vault_root` (or `status_page_uri` is set), `journal.ts status --footer`
ends with `**Podium:** <uri>`. The link is derived from the configuration: an `obsidian://open`
URI for the vault named by `obsidian_vault`, pointing at `<status_dir relative to vault_root>/The-Podium`.
An explicit `status_page_uri` wins over the derived one, so after the rename it must name
`The-Podium`, not `NOW`. Nothing install-specific is built in; with neither setting there is no line.

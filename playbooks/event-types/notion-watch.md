# Event type: notion-watch

Watches Notion pages that were pulled into the vault and tagged. Script: [scripts/event-types/notion-watch.ts](../../scripts/event-types/notion-watch.ts) (a shim over the shared engine in [scripts/lib/tag-watch.ts](../../scripts/lib/tag-watch.ts)); the Notion calls live in the separate `notion-sync` skill, which must be installed (the shim looks beside this repo, in `~/dev-env/skills/` and in `~/.claude/skills/`, or where `NOTION_SYNC_DIR` points).

The check is a script and costs no tokens: one cheap read of each page's last-edited time per tick. Nothing moved means nothing is reported and you are never woken. Only a real change reaches you, as one line that points at a diff file.

## Register (once per registry)

The target is the tag registry file, an absolute path to the JSON that `notion-pull` fills. The key reaches the scripts only through `with-env`, which the watcher calls itself; do not export it, read it or look for it.

`node scripts/event-loop.ts add --id notion --type notion-watch --target <registry.json> --report "Notion page changed: read the diff file and tell the user what changed"`

Defaults: checks every 15 minutes (`--interval S` to change; never below the network floor), lives 72 hours (re-register when it reports `watch expired`), notifies unless `--no-notify`. To tag a page, run `notion-pull` (see the notion-sync skill); the watcher picks the new tag up on its next tick.

## What the loop reports

| Digest line starts with | Actionable | What it means | What to do |
|---|---|---|---|
| `NOTION-CHANGED tag= note= diff= summary=` | yes | The page changed and its vault note was already re-written. `diff` is a unified diff of the note, `summary` is lines added and removed. | Read the file at `diff=` and nothing else. Tell the user in a few sentences what changed and why it might matter, quoting the tag. |
| `NOTION-UNSHARED tag= reason=` | yes | The page now answers 404 or 403 (unshared or deleted) or is archived. The note on disk is the last good copy. | Tell the user the tag and reason. They decide whether to re-share or drop the tag. Do not retry. |
| `NOTION-CHECK-FAILING tag= <message>` | no | Three checks in a row failed (network, or a pull error). It is not repeated. | Mention it only if it is still there at the end of the day. Do not debug. |

A rate limit (429) produces no line: the watcher waits out Retry-After and tries again by itself.

## Do not

- Fetch the Notion page yourself, by any means (web fetch, MCP, curl). The note and the diff file are the pulled copy; a second fetch spends tokens to learn what the diff already says.
- Read the whole note when the diff answers the question. Open it only if the user asks for more.
- Edit the note or the diff file, or write to Notion. The watcher owns them; Notion access is read-only.
- Open, source or print any env file or the key. If a line says the key is missing, tell the user to run `with-env --list` and stop.

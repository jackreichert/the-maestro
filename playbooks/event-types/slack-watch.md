# Event type: slack-watch

Watches Slack conversations that were pulled into notes and tagged. Script: [scripts/event-types/slack-watch.ts](../../scripts/event-types/slack-watch.ts) (a shim over the shared engine in [scripts/lib/tag-watch.ts](../../scripts/lib/tag-watch.ts)); the Slack calls live in the separate `slack-sync` skill, which must be installed (the shim looks beside this repo, in `~/dev-env/skills/` and in `~/.claude/skills/`, or where `SLACK_SYNC_DIR` points).

The check is a script and costs no tokens: one history call per tagged conversation per tick. Nothing newer means nothing is reported and you are never woken. Only new messages reach you, as one line that points at a file holding just the new lines.

## Register (once per registry)

The target is the tag registry file, an absolute path to the JSON that `slack-pull --register` fills (the slack-sync default is `~/.local/state/slack-sync/slack-tags.json`). The token reaches the scripts only through `with-env`, which the watcher calls itself; do not export it, read it or look for it.

`node scripts/event-loop.ts add --id slack --type slack-watch --target <registry.json> --report "Slack conversation has new messages: read the new-messages file and tell the user what is new"`

Defaults: checks every 5 minutes (`--interval S` to change; never below the network floor), lives 72 hours (re-register when it reports `watch expired`), notifies unless `--no-notify`. To tag a conversation, run `slack-pull` with `--register` (see the slack-sync skill); the watcher picks the new tag up on its next tick and never registers anything itself.

## What the loop reports

| Digest line starts with | Actionable | What it means | What to do |
|---|---|---|---|
| `SLACK-NEW tag= note= new= file=` | yes | New messages arrived and the note was already appended. `file` holds only the new lines, `new` is how many. | Read the new-messages file and nothing else. `events wait` shows only `tag`, `count`, `stamp` (the digest line is gone once claimed), so rebuild the path: the registry is this watch's target in `event-loop.ts list`; read `tags.<tag>.note_path` from it; the file is `<note_path minus .md>.new-<stamp>.md`. Never fall back to the newest file: with more than one unacked event it is the wrong one. Tell the user in a few sentences what is new and why it might matter, quoting the tag. When `slack_triage_rules` is set, triage the file by [playbooks/slack-triage.md](../slack-triage.md) instead of reading it whole. |
| `SLACK-UNSHARED tag= reason=` | yes | The token can no longer read the conversation (`channel_not_found`, `not_in_channel`, `is_archived` or `missing_scope`). The note is the last good copy. | Tell the user the tag and reason. They decide whether to re-invite or drop the tag. Do not retry. |
| `SLACK-CHECK-FAILING tag= <message>` | no | Three checks in a row failed. It is not repeated. | Mention it only if it is still there at the end of the day. Do not debug. |

A rate limit (429) produces no line: the watcher waits out Retry-After and tries again by itself.

## Do not

- Fetch the conversation yourself, by any means (Slack MCP, curl, web). The note and the new-messages file are the pulled copy.
- Read the whole note when the new-messages file answers the question. Open it only if the user asks for more.
- Edit the note or the file, or write to Slack. The watcher owns them; Slack access is read-only.
- Open, source or print any env file or the token. If a line says the token is missing, tell the user to run `with-env --list` and follow `playbooks/setup-slack-app.md` in the slack-sync skill, then stop.
- Spread message text. The notes may hold direct messages: quote as little as the question needs, never copy message text into tickets, Jira, PRs or chat beyond what the user asked for, and treat the tag list as the allowlist: do not suggest adding conversations.

# Playbook: a command only the user can run

Use this when a tool call is denied, a permission is missing, or a step needs the user's hands (a ticket close, an allow rule, a settings or vault write). Do not stop at pasting a block in chat: it scrolls away and says nothing about why.

## Steps

1. **Decide the kind.** `one-time` for a single act that will not come up again (close this ticket). `reusable` for a tool worth running again (refresh a cache, a diagnostic). When unsure, `one-time`: it can be registered as reusable later, and a one-time script leaves the list once done.
2. **Write the explanation first**, in plain language, one line each:
   - `--what`: what the command does.
   - `--why`: which work it unblocks, naming its ledger or ticket id.
   - `--after`: what is true once it has run.
   - `--blocks <id>`: the ledger or ticket id of the blocked work. `--blocked-by "<agent: task>"`: who hit the wall.
3. **Register it**, with the command after `--` (bare `node` for a `.ts` file is refused: use `/opt/homebrew/bin/node`; the same paste-lint and secret rules apply):

   ```bash
   node scripts/journal.ts script add --kind one-time --title "<title>" --what "<what>" --why "<why>" --after "<after>" --blocks <id> --blocked-by "<agent: task>" --model "<name>" --used "skill:the-maestro" -- <command>
   ```

   It prints the script id and the ask id. Registering again while it still waits returns the same entry.
4. **Carry on** with whatever is not blocked, and say in your report that the script is waiting on the user (by its title, with a link).
5. **When the user has run it** (the ask resolves, or `journal.ts script ran <id>` records it), re-verify the thing it unblocked before you continue.

## Never

- Never put a secret value in the command or the prose; name the variable. The registration refuses a secret-shaped value and writes nothing.
- Never run the command yourself to "check" it: the point is that the user reviews it.
- Never register something an agent can do itself.

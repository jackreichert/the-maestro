# Agent setup: Maestro 2.0

Install skills only. No live installation is authorized by this document itself. Follow applicable safety/Git rules; never read `.env*`, `ssm-*.json`, or secret-bearing files.

## 1. Confirm

- Read [README](./README.md), [settings contract](./README.md#settings), and [Maestro](./SKILL.md).
- Ask for harness, scope (workspace/user), absolute source/destination, vault/ledger/container paths, and approval for exact file/symlink changes. Read-only inspection is fine; do not change Git, global instructions, old plugins, hooks, or vault data without permission.
- Inspect the destination and existing Maestro registrations. Stop on collisions; preserve unrelated files and user edits. Record only the specific prior settings/links needed to reverse approved changes, never copy secret files.

## 2. Configure

- After approval, create/update `~/.config/the-maestro-redux/settings.json` using confirmed values and [public defaults](./settings.json). Preserve existing valid overrides; check JSON and the documented contract. Do not invent repo mappings.
- Tell the user this is agent-read configuration, with no executable loader or secret scanning. Unset paths may remain `null` for unused capabilities; required unresolved paths block that operation.

## 3. Register the bundle

- Claude Code workspace scope: `<container>/.claude/skills/the-maestro-redux`; user scope: `~/.claude/skills/the-maestro-redux`. Use an approved symlink to this entire repo or copy the complete bundle, excluding `.git` and prohibited files. Preserve relative paths; don't flatten child skills into separate destinations.
- Verify current target-harness documentation before acting; use its supported skill directory for other harnesses. Confirm symlink support/discovery rather than assuming it.
- Keep root/child frontmatter unchanged: child automatic invocation is disabled, but Maestro can read their linked files. This is not a packaged Claude Code plugin; don't invent plugin-install commands.
- Disable only explicitly approved competing old Maestro instructions for the test session. Do not remove old memory/hooks as part of this setup. If old hooks still mutate overlapping records, isolate the test or stop for a migration decision.

## 4. Verify in a fresh session

- Resolve the installed root and every relative skill/reference/template link. Validate settings and report resolved paths without secrets.
- Confirm the harness discovers root Maestro. Explicitly invoke/select it if necessary; neither a symlink nor skill discovery guarantees every startup loads it.
- Test a planning request and a Podium question request: check selective reads, settings resolution, and proposal/approval boundaries. Don't claim a hash saved or a question removed unless an actual permitted ledger/vault write was read back.
- Confirm no new hooks, watchers, loops, plugin activation, or runtime persistence were installed. Report each check/result and anything untested; disk layout alone is not discovery proof.

## 5. Handoff / rollback

Report installed source/destination, local settings location, changes, validation, limits, and exact reversal steps. Rollback requires approval: undo only this installation's registrations/settings changes, restore preserved prior values, leave repo/vault history and unrelated files untouched. Never broadly delete a skills/config directory.

If asked to enable automatic persistence, stop and scope the missing implementation/tests separately. This setup cannot supply them.

## Future Stop / PreCompact hook setup

**Blocked until the writer exists; do not register a placeholder command.**

1. Implement/test the prepared-delta writer against [Ledger's contract](./ledger/SKILL.md): stable IDs, revision conflicts, independent acknowledgements, partial-failure retries, and no transcript scraping or summarizing agent.
2. Verify current Claude Code hook documentation and installed version. After approval, merge a `Stop` command-hook entry into the chosen scope's Claude settings (`.claude/settings.json` for workspace scope or `~/.claude/settings.json` for user scope); preserve unrelated hooks/settings. Maestro's own settings file does not register Claude hooks.
3. Point the command to the verified writer using explicit resolved paths and supported hook input/output. It flushes only prepared operations, exits promptly, and avoids Stop continuation loops. Never guess command arguments before the writer defines them.
4. Register slim `PreCompact` separately: flush pending continuation only, with the same retry IDs; no retro, cleanup, discovery, or PR polling. Check for competing old memory hooks before enabling either.
5. In an isolated test vault, verify actual Stop delivery, duplicate invocations, interrupted turns, partial writes, question resolution/removal, and compaction before Stop. Read back all affected surfaces; report failures rather than claiming persistence.

Executable commands/config examples will be added with the writer. Until then, there is no working automatic Stop installation.

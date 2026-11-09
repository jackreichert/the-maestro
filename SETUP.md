# Agent setup: Maestro 2.0

This runbook grants no installation permission. Never read secret files or migrate old memory implicitly. [Runtime commands/limits](./reference/persistence.md) are part of setup.

## 1. Confirm scope

- Read [README](./README.md), [settings](./README.md#settings), and [Maestro](./SKILL.md).
- Ask for harness, workspace/user scope, absolute source/destination, vault/ledger/container paths, and approval for exact registration/settings/hook changes. Read-only inspection is fine; preserve unrelated settings/files.
- Inspect existing registrations and competing writers. Stop on collisions; disable old hooks/instructions only with approval. Do not remove old memory. Preserve only the specific prior registrations/settings needed for reversal, never copy secrets.

## 2. Configure and register

- Verify Node 24 and `node:sqlite`; run `npm test` in the bundle. No dependencies need installing. Resolve the actual Node executable to an absolute path for hooks.
- After approval, configure `~/.config/the-maestro-redux/settings.json` (or an explicit `--settings` override), preserving valid existing values. Persistence requires existing, owner-controlled, separate ledger/vault roots; ask before creating them. Settings files and in-root paths cannot be symlinks; no secrets in config.
- Claude Code workspace: `<container>/.claude/skills/the-maestro-redux`; user: `~/.claude/skills/the-maestro-redux`. Use an approved symlink to the complete repo or copy the bundle, excluding `.git` and prohibited files. Preserve relative links; do not flatten child skills.
- Check current target-harness skill documentation and discovery/symlink support. Keep frontmatter unchanged. This is not a packaged plugin; child skills are explicitly read, not independent slash commands.

## 3. Optional Claude Code hooks

Verify [current hook documentation](https://code.claude.com/docs/en/hooks.md) and installed version first. For other harnesses, register no guessed equivalent.

After explicit approval, **merge** these command hooks into the chosen Claude Code settings: `.claude/settings.json` for workspace or `~/.claude/settings.json` for user scope. Maestro's own settings do not register hooks. Preserve all unrelated hooks/settings.

Illustration: replace each `/absolute/...` with a verified absolute path, including the Node executable. Do not execute placeholders. Quote paths as shown; reject or correctly escape embedded shell quotes.

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "\"/absolute/node\" \"/absolute/bundle/scripts/memory.mjs\" hook --settings \"/absolute/settings.json\"",
        "timeout": 30
      }]
    }],
    "PreCompact": [{
      "matcher": "manual|auto",
      "hooks": [{
        "type": "command",
        "command": "\"/absolute/node\" \"/absolute/bundle/scripts/memory.mjs\" hook --settings \"/absolute/settings.json\"",
        "timeout": 30
      }]
    }]
  }
}
```

Both entry points consume Claude JSON on stdin and flush stable pending IDs for that session. Do not make them asynchronous or add blocking/continuation output. They emit bounded plain-text recovery guidance; PreCompact stdout may become compaction instructions. Partial failures exit `1`, not `2`; inspect receipts/debug logs because harness notification visibility varies. No prepared checkpoint means unverified capture, not success.

Stop is not an API-error hook. Interrupted turns may never deliver it; save important decisions immediately. No StopFailure handler is installed by this runbook.

## 4. Optional Claude Code status line

The status line is separate from Stop/PreCompact hooks. It updates in the Claude Code UI when assistant messages arrive; it does not append text to chat replies.

After explicit approval, merge this setting into the selected Claude Code settings file. Replace placeholders with verified absolute paths and preserve existing settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"/absolute/node\" \"/absolute/bundle/scripts/statusline.mjs\" --settings \"/absolute/settings.json\""
  }
}
```

The script shows PRs authored by the current user in the active repository (draft, changes requested, and approved/mergeable) plus their total open PR count across GitHub. It also shows Claude Code's estimated session cost and context percentage, unresolved Ledger questions, and an OSC 8 Podium file link when the terminal supports it. It prefers `Podium/README.md`, then falls back to `Projects/<container-name>/Status/The-Podium.md`. PR state comes from `gh`; the ledger and Podium sections require their configured roots. Missing roots or data are shown as unavailable. The cost is Claude Code's estimate, not a billing statement.

## 5. Rehearse before live memory

- Use approved isolated test roots first. Confirm root skill discovery in a fresh session; linking files alone is not proof. Check every relative link and selective child-skill loading.
- Prepare a synthetic checkpoint with the actual session ID before responding. Verify **actual** Stop delivery/read-back for ledger, Podium and library, then compaction before Stop, repeated delivery, revision conflict, partial failure and safe retry. Subprocess tests do not prove lifecycle delivery.
- Resolve a synthetic hash-linked question and confirm its decision precedes removal from every open Podium list. Rehearse quoted/vault matching and ambiguity in the agent, not the writer.
- Refresh a topic brief, append a correction, and verify a fresh agent recovers rationale plus the newer event. Validate ownership and permissions independently of old receipts.
- Report results and gaps. Do not enable live roots until the user accepts the rehearsal. No zero-loss guarantee, loops, watchers, scheduled retros or automatic PR sync.

## 6. Handoff and rollback

Report source/destination, local config, exact hook changes, validation and untested limits. Rollback needs approval: remove only these registrations/hooks, restore preserved values, and leave vault/ledger history and unrelated files intact. Never broadly delete skill/config directories or steal writer locks.

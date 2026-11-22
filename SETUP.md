# Agent setup: Maestro 2.0

This runbook grants no installation permission. Never read secret files or migrate old memory implicitly. [Runtime commands/limits](./reference/persistence.md) are part of setup.

## 1. Confirm scope

- Read [README](./README.md), [settings](./README.md#settings), and [Maestro](./SKILL.md).
- Ask for harness, workspace/user scope, absolute source/destination, vault/ledger/container paths, and approval for exact registration/settings/hook changes. Read-only inspection is fine; preserve unrelated settings/files.
- Confirm the installing user's Git author identities, repository branch flow and optional integrations. No Git/PR write permissions are pre-granted: ask for desired actions and record any explicit scoped standing grants through Ledger. Do not copy another installation's grants, identity or hook paths.
- Inspect existing registrations and competing writers. Stop on collisions; disable old hooks/instructions only with approval. Do not remove old memory. Preserve only the specific prior registrations/settings needed for reversal, never copy secrets.

## 2. Configure and register

- Verify Node 24 and `node:sqlite`; run `npm test` in the bundle. No dependencies need installing. Resolve the actual Node executable to an absolute path for hooks.
- For optional GitHub features, verify `gh` and authentication for the installing user's account. Missing GitHub access must not block local memory/tickets; the footer reports unavailable PR data. Jira is optional and requires separately configured tooling/access.
- After approval, configure `~/.config/the-maestro/settings.json` (or an explicit `--settings` override), preserving valid existing values. Persistence requires existing, owner-controlled, separate ledger/vault roots; ask before creating them. Settings files and in-root paths cannot be symlinks; no secrets in config.
- Claude Code workspace: `<container>/.claude/skills/the-maestro`; user: `~/.claude/skills/the-maestro`. Use an approved symlink to the complete repo or copy the bundle, excluding `.git` and prohibited files. Preserve relative links; do not flatten child skills.
- For existing installations, keep explicit `--settings` paths until migration is approved. Update installed skill links to match the skill name only with approval; check for legacy-name collisions first. Repository naming changes do not migrate registrations or storage.
- Check current target-harness skill documentation and discovery/symlink support. Keep frontmatter unchanged. This is not a packaged plugin; child skills are explicitly read, not independent slash commands.
- Outside Claude Code, use the harness's supported skill registration and agent/model preferences. Do not copy Claude hooks, agent type names or terminal assumptions as if they were portable. Manual memory commands remain available. The optional Cursor and Grok Code sections below start a turn on prompt submit and flush it before compaction. Do not invent a hook for a harness that is not documented.

## 3. Optional Claude Code hooks

Verify [current hook documentation](https://code.claude.com/docs/en/hooks.md) and installed version first. Do not register a guessed hook for a harness that is not documented here. The Cursor and Grok Code sections below are not copies of these Claude hooks.

After explicit approval, **merge** these command hooks into the chosen Claude Code settings: `.claude/settings.json` for workspace or `~/.claude/settings.json` for user scope. Maestro's own settings do not register hooks. Preserve all unrelated hooks/settings.

Illustration: replace each `/absolute/...` with a verified absolute path, including the Node executable. Do not execute placeholders. Quote paths as shown; reject or correctly escape embedded shell quotes.

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "\"/absolute/node\" \"/absolute/bundle/scripts/memory.mjs\" hook --settings \"/absolute/settings.json\"",
        "timeout": 30
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "\"/absolute/node\" \"/absolute/bundle/scripts/memory.mjs\" hook --settings \"/absolute/settings.json\"",
        "timeout": 30
      }]
    }],
    "StopFailure": [{
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

Keep all four hooks synchronous. The [runtime contract](./reference/persistence.md#hooks-and-limits) defines injected instructions, current-turn coverage, bounded repair, interruption and exit codes; do not override it with additional continuation loops.

After separate permission approval, allow the exact resolved Node/script prefixes for `prepare`, `flush`, `current`, `search`, `lookup`, and `recover`, plus a `Read` rule for the contract document. Use the same single-quoted command paths injected by the hook; Claude Code absolute `Read` paths use `//`. Do not grant unrestricted Bash/Read or bypass deny rules. Without these permissions, agents may need tool approval; a guard cannot grant it.

Start a fresh Claude Code session after registration; tracking begins at the next delivered prompt. A manual hook run proves the command works, not lifecycle delivery. Rehearse below before relying on live memory.

### Optional session events

Session monitoring is separate from the four synchronous memory hooks. Only after explicit approval, follow the [event installation and coverage contract](./reference/events.md#installation-and-coverage): private local root, additional asyncRewake listeners, synchronous SessionEnd, narrow explicit-ack permission and isolated live rehearsal. Preserve existing memory hooks. Listener timeouts bound idle coverage; installing this is not permission for autonomous PR/Git changes. No event hooks are installed by this repository.

## Optional Cursor prompt and preCompact

These two events are for Cursor. They are not Claude hooks. Verify [the current hook documentation](https://cursor.com/docs/hooks) before registering.

Cursor loads `~/.cursor/hooks.json` and `<repo>/.cursor/hooks.json`. User hooks do not run on cloud agents. Maestro's own settings do not register this hook. This bundle does not write a live `~/.cursor/hooks.json` or a project `.cursor/hooks.json`.

After explicit approval, merge only `beforeSubmitPrompt` and `preCompact` into the chosen file. Preserve unrelated hooks. Do not add other events.

`beforeSubmitPrompt` starts the turn when `conversation_id` is an identifier, then returns `{"continue": true}`. It does not block the prompt. `preCompact` flushes that same turn. Replace each `/absolute/...` path. Do not execute the placeholders. Quote paths as shown.

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{
      "command": "\"/absolute/node\" \"/absolute/bundle/scripts/cursor-hook.mjs\" --settings \"/absolute/settings.json\""
    }],
    "preCompact": [{
      "command": "\"/absolute/node\" \"/absolute/bundle/scripts/cursor-hook.mjs\" --settings \"/absolute/settings.json\""
    }]
  }
}
```

A manual run proves the command, not live delivery.

## Optional Grok Code prompt and preCompact

These two events are for the Grok Code terminal. They are not Claude hooks and not Cursor hooks. Verify [the current hook documentation](https://docs.x.ai/build/features/hooks) before registering.

Grok Code loads `~/.grok/hooks/*.json` and `<repo>/.grok/hooks/*.json`. A project file does not run until that repo is trusted with `/hooks-trust` or `--trust`. Maestro's own settings do not register this hook. This bundle does not write a live `~/.grok` file or a project `.grok` file.

After explicit approval, merge only `UserPromptSubmit` and `PreCompact` into the chosen hooks file. Preserve unrelated hooks. Do not add other events.

The stdin field `hookEventName` is `user_prompt_submit` for a prompt and `pre_compact` before compaction. The file keys are `UserPromptSubmit` and `PreCompact`. Both read stdin `sessionId`. They do not fall back to `GROK_SESSION_ID`. Omit `matcher` on `PreCompact` so both `manual` and `auto` compaction flush. A matcher on `UserPromptSubmit` does not apply. The documented default timeout is 5 seconds. The placeholder uses 30 so a flush is not killed early. Replace each `/absolute/...` path. Do not execute the placeholders. Quote paths as shown.

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "\"/absolute/node\" \"/absolute/bundle/scripts/grok-hook.mjs\" --settings \"/absolute/settings.json\"",
        "timeout": 30
      }]
    }],
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "\"/absolute/node\" \"/absolute/bundle/scripts/grok-hook.mjs\" --settings \"/absolute/settings.json\"",
        "timeout": 30
      }]
    }]
  }
}
```

`UserPromptSubmit` is not a blocking event. The script starts the turn and exits 0. It prints nothing, because Grok ignores stdout on this event. `PreCompact` flushes that same turn and also prints nothing. A non-zero exit is recorded and does not stop the prompt or compaction. A manual run proves the command, not live delivery.

## 4. Optional Claude Code status line

The status line is separate from Stop/PreCompact hooks. It updates in the Claude Code UI when assistant messages arrive; it does not append text to chat replies.

The Podium link appears immediately after `Maestro` so it remains visible when the terminal truncates the status line.

After explicit approval, merge this setting into the selected Claude Code settings file. Replace placeholders with verified absolute paths and preserve existing settings:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"/absolute/node\" \"/absolute/bundle/scripts/statusline.mjs\" --settings \"/absolute/settings.json\""
  }
}
```

The footer shows the authenticated user's total authored open PRs across GitHub, including drafts: `Open PRs 41`. It queries the PR connection total without fetching PRs, requiring a local repository, or using GitHub search's result limit. Podium lists active work, not every open PR. Other fields show estimated session cost, context use, unresolved Ledger questions, checkpoint health and an OSC 8 Podium link on supported terminals.

Successful saves show `Muninn Nov 10 13:43`: the last checkpoint acknowledgement in local time, with daylight-saving adjustments, an English abbreviated month and 24-hour minutes. The display omits year, seconds and timezone; storage remains UTC. The timestamp carries across turns within the session and does not advance on repeated Stop hooks. Older saved records without a time show `Muninn unknown`. Pending, missing, failed and interrupted states remain visible beside the last known checkpoint.

Gap counts stay recorded but not in the footer. They count earlier turns not marked saved when the next prompt began, including pending turns—not proven data loss. Put relevant diagnostics in Podium's Resume section during normal coordination updates; the footer does not write them. Checkpoints acknowledge requested writes, not complete fact capture.

The Podium link opens Obsidian using `obsidian://open?path=<encoded absolute note path>`, preferring `Podium/README.md`, then `Projects/<container-name>/Status/The-Podium.md`. Obsidian must be installed with the vault registered, and the terminal must allow OSC 8 custom-scheme links; verify a click in the target terminal. Vault-note links inside Podium use Obsidian wikilinks; PR/web links remain HTTPS. PR state comes from `gh`; the ledger and Podium sections require their configured roots. Missing roots or data are shown as unavailable. Failed or invalid PR responses are reported on stderr rather than displayed as a zero count. The cost is Claude Code's estimate, not a billing statement.

## 5. Rehearse before live memory

- Use approved isolated test roots first. Confirm root skill discovery in a fresh session; linking files alone is not proof. Check every relative link and selective child-skill loading.
- Prepare a synthetic checkpoint with the actual session ID before responding. Verify **actual** Stop delivery/read-back for ledger, Podium and library, then compaction before Stop, repeated delivery, revision conflict, partial failure and safe retry. Subprocess tests do not prove lifecycle delivery.
- Submit another prompt without preparing a checkpoint: the prior turn's receipts must not satisfy it. Verify the Stop guard requests automatic repair once, allows a successful repair to finish, and leaves failure visible without repeated continuation. Rehearse StopFailure in isolation; a forced hook subprocess is not proof of actual API-error delivery.
- Resolve a synthetic hash-linked question and confirm its decision precedes removal from every open Podium list. Rehearse quoted/vault matching and ambiguity in the agent, not the writer.
- Refresh a topic brief, append a correction, and verify a fresh agent recovers rationale plus the newer event. Validate ownership and permissions independently of old receipts.
- Report results and gaps. Do not enable live roots until the user accepts the rehearsal. No zero-loss guarantee, loops, watchers, scheduled retros or automatic PR sync.

## 6. Handoff and rollback

Report source/destination, local config, exact hook changes, validation and untested limits. Rollback needs approval: remove only these registrations/hooks, restore preserved values, and leave vault/ledger history and unrelated files intact. Never broadly delete skill/config directories or steal writer locks.

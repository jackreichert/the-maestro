# Local config (install overlay)

**This file names the install-specific settings; it holds no values.** Every other generic file states its rule generically and says "from local-config" where it needs one of these. Where the values live is set up per install, as described below. The script-side twin is [scripts/local-config.mjs](../scripts/local-config.mjs), which reads the same values from environment variables and from the config file.

Personal preferences (greeting style, sign-offs) do not belong in either; they live in the user's own CLAUDE.md or memory.

## Org overlay

An org overlay is a separate skill that holds one org's values and rules: repo topology, tracker rules, data rules, release steps, and a `config.md` with the settings below filled in. The generic skill never names it by path. It is named by configuration:

- **`overlay` in the config file, or the environment variable `MAESTRO_OVERLAY`** (the variable wins). Either a skill name (`<skill>`) or a plugin-qualified skill name (`<plugin>:<skill>`, the form Claude Code uses for plugin skills).
- **Unset means no overlay.** The skill is then fully generic, and a rule that says "from the org overlay" simply has no extra source.
- **If an overlay is configured, load that skill (invoke it by its configured name) and follow it.** Read only the overlay file the task needs.

## Config file

The scripts read one small file. It is markdown, so it can sit inside an overlay skill next to its prose. The scripts read only a fenced block tagged `maestro-config`, one `key: value` per line; everything else in the file is prose and is ignored.

````markdown
```maestro-config
overlay: <skill>            # or <plugin>:<skill>; omit for no overlay
gh_org: <github-org>        # PR board scope; omit for no org filter
gh_login: <github-login>    # omit to use `gh api user`
project: <container-name>   # ledger paths Projects/<name>/Journal/
projects_dir: /path/to/claude/projects/<container>
ledger_root: /path/to/ledger
vault_root: /path/to/vault
```
````

Every key is optional. Blank values are ignored.

## How the scripts find it

Precedence per setting: **environment variable, then the user file, then the overlay's `config.md`.**

The user file is the first of:

1. `MAESTRO_LOCAL_CONFIG`, an explicit file path. Set it to the empty string to read no config file at all (the tests do this).
2. `~/.config/the-maestro/config.md`.

The overlay's `config.md` is found from the overlay name (set in the user file or `MAESTRO_OVERLAY`), first hit wins:

3. **Plugin skill** (`<plugin>:<skill>`): Claude Code records installed plugins in `~/.claude/plugins/installed_plugins.json`, an object `plugins` keyed `<plugin>@<marketplace>`, each entry a list whose items carry an `installPath`. The skill is at `<installPath>/skills/<skill>/config.md`.
4. **Sibling skill**: `../<skill>/config.md`, relative to this skill's directory. This is looked up both by the path the script was started through (so it works when this skill is a symlink into a repo checkout) and by its real path, and then in `~/.claude/skills/<skill>/config.md`.

The environment variables that override single settings are `MAESTRO_OVERLAY`, `MAESTRO_GH_ORG`, `MAESTRO_GH_LOGIN`, `MAESTRO_PROJECT`, `MAESTRO_PROJECTS_DIR`, `LEDGER_ROOT`, and `VAULT_ROOT`. A variable that is set to the empty string counts as set.

## Roots and names

| Setting | Used by |
|---|---|
| Container directory | repo routing, worktrees |
| Container project name | ledger paths `Projects/<name>/Journal/`; `project` / `CONTAINER_PROJECT` |
| `VAULT_ROOT` | tickets, `CONTEXT.md`, `DECISIONS.md`, `Plans/`, `Research/`, `Reviews/` |
| Obsidian vault name (for `obsidian://open?vault=`) | greeting.md, citations.md |
| `LEDGER_ROOT` | `journal.mjs`, `ledger-index.mjs`, `prs-snapshot.mjs`, `pr-watch.mjs --state` |
| Claude transcript dir | `token-metrics.mjs` (`CLAUDE_PROJECTS_DIR`) |
| Ticket skill | dispatch.md |

## Git identity and branch topology

| Setting | Used by |
|---|---|
| The user's git emails (authorship check) | git.md, the standing brief block |
| GitHub login | PR scripts (read from `gh api user` unless `gh_login` / `MAESTRO_GH_LOGIN` is set) |
| GitHub org for the PR board | prs.md, `GH_ORG` in local-config.mjs |
| Protected branches | git.md |
| Default branch base, and per-repo exceptions | git.md step 1 |
| Deploy PR the user opens themselves | git.md step 4 |
| Review bots whose threads we may resolve | prs.md |

## Issue tracker

| Setting | Used by |
|---|---|
| Tracker and its MCP | greeting.md, ledger.md |
| Site (browse URLs) | greeting.md, prs.md |
| Default project key | greeting.md |
| Key in branch names, and any placeholder for local-only branches | git.md step 1 |
| Key in commit subjects | the standing brief block |

## Standing brief block, filled

[dispatch.md](dispatch.md#standing-brief-block--paste-once-into-every-brief) keeps the block generic with two `<…>` slots, `<user git emails>` and `<tracker key example>`. Their values come from the overlay's `config.md` (or your own values file), under a heading "Standing brief block, filled". Without an overlay, ask the user once and reuse the answer.

## Changing this file

A setting is added here when a rule elsewhere would otherwise name a person, company, repo, path, or key. Keep the rule where it was, reworded to say "from local-config", list the setting here, and put the value in the values file.

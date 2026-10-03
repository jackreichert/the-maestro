# Local config (install overlay)

**This file names the install-specific settings; it holds no values.** Every other generic file states its rule generically and says "from local-config" where it needs one of these. Where the values live is set up per install, as described below. The script-side twin is [scripts/local-config.ts](../scripts/local-config.ts), which reads the same values from environment variables and from the config file.

Personal preferences (greeting style, sign-offs) do not belong in either; they live in the user's own CLAUDE.md or memory.

## Org overlay

An org overlay is a separate skill that holds one org's values and rules: repo topology, tracker rules, data rules, release steps, and a `config.md` with the settings below filled in. The generic skill never names it by path. It is named by configuration:

- **`overlay` in the config file, or the environment variable `MAESTRO_OVERLAY`** (the variable wins). Either a skill name (`<skill>`) or a plugin-qualified skill name (`<plugin>:<skill>`, the form Claude Code uses for plugin skills).
- **Unset means no overlay.** The skill is then fully generic, and a rule that says "from the org overlay" simply has no extra source.
- **If an overlay is configured, load that skill (invoke it by its configured name) and follow it.** Read only the overlay file the task needs.
- **An overlay can add event-loop watch types.** `event-loop.mjs` also loads `<overlay dir>/event-types/<type>.mjs` or `<type>.ts` (a name in both is a duplicate; the directory holding the overlay's `config.md`), each with its playbook `<type>.md` beside it, using the same `check`/`diff`/`done` interface as [playbooks/event-loop.md](../playbooks/event-loop.md#for-the-orchestrator-adding-an-event-type). A name that is already taken, a module without `check`/`diff` functions, or a missing playbook stops the loop with an error naming the file. An overlay `.ts` type runs under Node's type stripping, so it may use only erasable syntax (no `enum`, no namespaces), must import types with `import type`, and is not stripped under `node_modules`; a violation fails when the loop starts, not at typecheck. An overlay without `config.md`, or without an `event-types/` folder, adds nothing.

## Config file

The scripts read one small file. It is markdown, so it can sit inside an overlay skill next to its prose. The scripts read only a fenced block tagged `maestro-config`, one `key: value` per line; everything else in the file is prose and is ignored.

````markdown
```maestro-config
overlay: <skill>            # or <plugin>:<skill>; omit for no overlay
gh_org: <github-org>        # PR board scope; omit for no org filter
gh_login: <github-login>    # omit to use `gh api user`
project: <container-name>   # ledger paths Projects/<name>/Journal/
projects_dir: /path/to/claude/projects/<container>
roll_turns: 180                # the status footer's Session line says "roll now" at this many turns; default 180
roll_read_per_turn: 350000     # ... or at this mean cache-read per turn (a plain number); default 350000
ledger_root: /path/to/ledger
vault_root: /path/to/vault
loop_patterns: loop_a, loop_b  # pgrep -f patterns `journal.mjs resume` checks; omit for none
resume_gh: on                  # off skips `gh pr list` in `resume`; default on
ledger_git_autocommit: on      # on: `roll` commits the ledger root (if it is a git repo) after a clean `verify`; default off
approvals_review_day: friday   # weekday the morning greeting brings the approvals digest; default friday
watch_min_interval: 300        # PR watcher: fastest poll, seconds; never below 300; default 300
watch_max_interval: 1800       # PR watcher: slowest poll, seconds; default 1800
watch_quiet_hours: 20:00-07:00 # PR watcher: no polling in this local window; `off` disables; default 20:00-07:00
watch_quiet_hours_mode: stop   # stop: skip the PR watch (run exits if nothing else is live) until the next greeting; slow: poll every 1800s; default stop
watch_quiet_weekends: off      # on: Saturday and Sunday count as quiet hours; default off
watch_tz: America/New_York     # time zone for the quiet hours; default the system time zone
pr_max_code_files: 5           # PR size budget: most code files per PR; default 5
pr_max_code_lines: 400         # PR size budget: most changed code lines (adds + deletes); default 400
pr_test_globs: <globs>         # comma-separated path globs counted as tests; omit for the built-in defaults
pr_config_globs: <globs>       # ... as config; pr_docs_globs: docs; pr_mechanical_globs: lockfiles, generated, vendored
twin_flow_repos: repo_a, repo_b # repos with the integration/release-candidate twin-PR flow; omit to turn the rule off
copilot_orgs: my-org          # comma-separated owners whose draft PRs the pr-watch event type requests Copilot review on; omit to request nowhere
git_emails: me@example.com     # comma-separated; the authorship check in branch-sweep.mjs; omit to use each repo's user.email
protected_branches: main, release/*  # names or globs (`*` within one path segment, `**` across segments) branch-sweep.mjs never lists; setting it replaces the default, which is main, master, staging, develop, release/*, staging/*, hotfix/*; add backmerge/* here to protect those too
sweep_merge_targets: repo_a=develop|staging  # per-repo branches a branch must be merged into; default develop (plus staging in twin-flow repos)
sweep_pr_days: 180             # days of merged PRs branch-sweep.mjs reads as evidence; default 180
tracker_key_pattern: \bABC-\d+\b  # regex for tracker keys in a PR title or branch, listed by the pr-merged event; default is any ABC-123 shaped key
sweep_budget_seconds: 300     # the worktree sweep stops at the next repo boundary once over this many seconds, and names what it skipped; default 300
sweep_idle_minutes: 60         # a worktree must be untouched this long before branch-sweep.mjs offers it; default 60
sweep_protect_symlink_dirs: ~/code/skills  # extra dirs whose symlinks mark a worktree as a live skill; ~/.claude/skills and <container>/.claude/skills always count
sweep_disposable_ignored: node_modules, .venv, dist, __pycache__  # ignored paths that do not keep a worktree; any other ignored file does (default shown)
event_dir: /path/to/events     # event loop: registry, state, digest; default <ledger_root>/Events, else ~/.local/state/the-maestro/events
notify_command: ["my-notifier", "--to-me"]  # event loop: argv (JSON array); the one-line summary is appended as the last argument; used only for watches added with --notify (reminders by default); omit for no notifications
watch_network_floor: 120       # event loop: fastest poll for network types (pr-checks, pr-watch, gh-run), seconds; can only raise the 120 floor
watch_local_floor: 30          # event loop: fastest poll for local types (inbox, reminder), seconds; can only raise the 30 floor
watch_type_intervals: pr-checks=240, inbox=90  # event loop: default interval per type, seconds; the floors still apply
inbox_command: ["my-inbox", "--unread"]     # event loop `inbox` type: argv printing one line per unread message, without marking them read; omit for none
container_root: /path/to/container  # the only directory roll and handoff will sweep for stale worktrees, and only when run from inside it; a leading ~/ is expanded; omit and the sweep refuses
agent_owned_repos: ~/tools, ~/notes  # repos the agent manages itself: the protected-branch stop does not apply there (commit to the default branch); every other git rule still does; omit for none
scripts_dir: /path/to/scripts # shared scripts shelf: README.md index, scratch/, helpers/; a leading ~/ is expanded; omit to turn the shelf protocol off
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

The environment variables that override single settings are `MAESTRO_OVERLAY`, `MAESTRO_GH_ORG`, `MAESTRO_GH_LOGIN`, `MAESTRO_PROJECT`, `MAESTRO_PROJECTS_DIR`, `LEDGER_ROOT`, `VAULT_ROOT`, `MAESTRO_PR_MAX_CODE_FILES`, `MAESTRO_PR_MAX_CODE_LINES`, and `MAESTRO_PR_TEST_GLOBS` / `MAESTRO_PR_CONFIG_GLOBS` / `MAESTRO_PR_DOCS_GLOBS` / `MAESTRO_PR_MECHANICAL_GLOBS`, `MAESTRO_TWIN_FLOW_REPOS`, `MAESTRO_GIT_EMAILS`, `MAESTRO_PROTECTED_BRANCHES`, `MAESTRO_SWEEP_MERGE_TARGETS`, `MAESTRO_SWEEP_IDLE_MINUTES`, `MAESTRO_SWEEP_PROTECT_SYMLINK_DIRS`, `MAESTRO_SWEEP_DISPOSABLE_IGNORED`, `MAESTRO_APPROVALS_REVIEW_DAY`, and the watcher overrides `MAESTRO_WATCH_MIN_INTERVAL`, `MAESTRO_WATCH_MAX_INTERVAL`, `MAESTRO_WATCH_QUIET_HOURS`, `MAESTRO_WATCH_QUIET_HOURS_MODE`, `MAESTRO_WATCH_QUIET_WEEKENDS`, `MAESTRO_WATCH_TZ`, and the event loop overrides `MAESTRO_EVENT_DIR`, `MAESTRO_NOTIFY_COMMAND`, `MAESTRO_INBOX_COMMAND`, `MAESTRO_WATCH_NETWORK_FLOOR`, `MAESTRO_WATCH_LOCAL_FLOOR`, `MAESTRO_WATCH_TYPE_INTERVALS`, and the scripts shelf override `MAESTRO_SCRIPTS_DIR`. A variable that is set to the empty string counts as set.

## Roots and names

| Setting | Used by |
|---|---|
| Container directory | repo routing, worktrees |
| Container project name | ledger paths `Projects/<name>/Journal/`; `project` / `CONTAINER_PROJECT` |
| `VAULT_ROOT` | tickets, `CONTEXT.md`, `DECISIONS.md`, `Plans/`, `Research/`, `Reviews/` |
| Obsidian vault name (for `obsidian://open?vault=`) | greeting.md, citations.md |
| `LEDGER_ROOT` | `journal.mjs`, `ledger-index.mjs`, `prs-snapshot.mjs` |
| Claude transcript dir | `token-metrics.mjs` (`CLAUDE_PROJECTS_DIR`) |
| Ticket skill | dispatch.md |
| Whether `roll` commits the ledger root (`ledger_git_autocommit`) | `journal.mjs roll` |
| Weekday of the weekly approvals review (`approvals_review_day`, default Friday) | greeting.md, `journal.mjs approvals` |
| Loop process patterns (`loop_patterns`) and whether `resume` calls `gh` (`resume_gh`) | `journal.mjs resume` |
| Event loop: `event_dir`, `notify_command` (no default recipient: unset means no notifications; only watches added with `--notify` use it), `inbox_command`, `watch_network_floor`, `watch_local_floor`, `watch_type_intervals` | `event-loop.mjs`, `scripts/event-types/inbox.ts` |
| PR watcher cadence (the event loop reads `watch_max_interval` as its back-off cap, plus the quiet-hours keys): `watch_min_interval`, `watch_max_interval`, `watch_quiet_hours`, `watch_quiet_hours_mode`, `watch_quiet_weekends`, `watch_tz` | `scripts/event-loop.mjs` via `scripts/lib/cadence.ts` |

## Git identity and branch topology

| Setting | Used by |
|---|---|
| The user's git emails (authorship check; `git_emails`) | git.md, the standing brief block, `scripts/branch-sweep.mjs` |
| GitHub login | PR scripts (read from `gh api user` unless `gh_login` / `MAESTRO_GH_LOGIN` is set) |
| GitHub org for the PR board | prs.md, `GH_ORG` in local-config.ts |
| Protected branches (`protected_branches`) | git.md, `scripts/branch-sweep.mjs` |
| Branch-sweep merge targets (`sweep_merge_targets`), idle window (`sweep_idle_minutes`), PR look-back (`sweep_pr_days`), live-skill dirs (`sweep_protect_symlink_dirs`) and disposable ignored paths (`sweep_disposable_ignored`) | `scripts/branch-sweep.mjs`, ledger.md |
| Default branch base, and per-repo exceptions | git.md step 1 |
| Owners pr-watch requests Copilot review for (`copilot_orgs`; unset means none) | `scripts/event-types/pr-watch.ts` |
| Repos that use the twin-PR flow (`twin_flow_repos`), and the names of their integration and release-candidate branches | git.md, prs.md |
| Deploy PR the user opens themselves | git.md step 4 |
| Review bots whose threads we may resolve | prs.md |
| PR size budget: code-file and code-line limits (`pr_max_code_files`, `pr_max_code_lines`) and the test, config, docs and mechanical path globs (`pr_*_globs`) | git.md, `scripts/pr-size.mjs` |

## Issue tracker

| Setting | Used by |
|---|---|
| Tracker and its MCP | greeting.md, ledger.md |
| Site (browse URLs) | greeting.md, prs.md |
| Default project key | greeting.md |
| Key in branch names, and any placeholder for local-only branches | git.md step 1 |
| Key in commit subjects | the standing brief block |

## Standing brief block, filled

[brief.md](brief.md#standing-brief-block--paste-once-into-every-brief) keeps the block generic with two `<…>` slots, `<user git emails>` and `<tracker key example>`. Their values come from the overlay's `config.md` (or your own values file), under a heading "Standing brief block, filled". Write one bullet per slot, `- \`<user git emails>\` → value`, in the user file or the overlay's `config.md`; [scripts/brief-block.mjs](../scripts/brief-block.mjs) reads them (user file first) and prints the filled block. Without an overlay, ask the user once and put the answer in the user file.

## Changing this file

A setting is added here when a rule elsewhere would otherwise name a person, company, repo, path, or key. Keep the rule where it was, reworded to say "from local-config", list the setting here, and put the value in the values file.

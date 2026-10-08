# Local config (install overlay)

**This file names the install-specific settings; it holds no values.** Every other generic file states its rule generically and says "from local-config" where it needs one of these. Where the values live is set up per install, as described below. The script-side twin is [scripts/local-config.ts](../scripts/local-config.ts), which reads the same values from environment variables and from the config file.

Personal preferences (greeting style, sign-offs) do not belong in either; they live in the user's own CLAUDE.md or memory.

## Org overlay

An org overlay is a separate skill that holds one org's values and rules: repo topology, tracker rules, data rules, release steps, and a `config.md` with the settings below filled in. The generic skill never names it by path. It is named by configuration:

- **`overlay` in the config file, or the environment variable `MAESTRO_OVERLAY`** (the variable wins). Either a skill name (`<skill>`) or a plugin-qualified skill name (`<plugin>:<skill>`, the form Claude Code uses for plugin skills).
- **Unset means no overlay.** The skill is then fully generic, and a rule that says "from the org overlay" simply has no extra source.
- **If an overlay is configured, load that skill (invoke it by its configured name) and follow it.** Read only the overlay file the task needs.
- **An overlay can add event-loop watch types.** `event-loop.ts` also loads `<overlay dir>/event-types/<type>.mjs` or `<type>.ts` (a name in both is a duplicate; the directory holding the overlay's `config.md`), each with its playbook `<type>.md` beside it, using the same `check`/`diff`/`done` interface as [playbooks/event-loop.md](../playbooks/event-loop.md#for-the-orchestrator-adding-an-event-type). A name that is already taken, a module without `check`/`diff` functions, or a missing playbook stops the loop with an error naming the file. An overlay `.ts` type runs under Node's type stripping, so it may use only erasable syntax (no `enum`, no namespaces), must import types with `import type`, and is not stripped under `node_modules`; a violation fails when the loop starts, not at typecheck. An overlay without `config.md`, or without an `event-types/` folder, adds nothing.

## Config file

The scripts read one small file. It is markdown, so it can sit inside an overlay skill next to its prose. The scripts read only a fenced block tagged `maestro-config`, one `key: value` per line; everything else in the file is prose and is ignored.

````markdown
```maestro-config
overlay: <skill>            # or <plugin>:<skill>; omit for no overlay
gh_org: <github-org>        # PR board scope; omit for no org filter
gh_login: <github-login>    # omit to use `gh api user`
project: <container-name>   # ledger paths Projects/<name>/Journal/
projects_dir: /path/to/claude/projects/<container>   # omit to follow container_root (else the working directory)
roll_turns: 180                # turns that count as 100% on the status footer's Session line; default 180
roll_read_per_turn: 350000     # ... and mean cache-read per turn that counts as 100% (a plain number); default 350000
roll_warn_pct: 60              # Session line says "roll soon" at this percent of either; 1..100, below roll_at_pct; default 60
roll_at_pct: 90                # ... and "roll now" at this percent; a pair with warn >= roll falls back to 60/90; default 90
ledger_root: /path/to/ledger
vault_root: /path/to/vault
loop_patterns: loop_a, loop_b  # pgrep -f patterns `journal.ts resume` checks; omit for none
update_check: on               # off stops `prime` fetching this skill's own repo to report behind/ahead/diverged/dirty; default on
auto_pull: off                 # on: `prime` fast-forwards a clean, purely-behind skill checkout (merge --ff-only only); off: never, and silences the ask; unset (the default) behaves as off but `prime` asks you to choose each session
resume_gh: on                  # off skips `gh pr list` in `resume`; default on
notes_check_since: 30d        # how far back the roll and the notes-reachable row look for notes no stream tab lists: 30d, YYYY-MM-DD, or all; default 30d
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
pr_body_sections: Context, Reviewer guide, Risk and blast radius, Rollback / flag, How to verify locally # headings pr-open.ts requires in every PR body; this is the default list
pr_body_check_risk: on         # also: pr_body_check_verify, pr_body_check_forbidden, pr_body_check_diagram; each on by default, off turns it off
pr_body_private_words: ledger, vault # words refused outside code in a PR title or body; default ledger, vault, Podium, orchestrator; `none` empties the list
pr_body_private_patterns: \bX-\d+\b # extra regexes for private ids a PR must not carry (comma-separated, no commas inside); checked in title and body
pr_body_voice_names: Sam, samf # your names or logins that must not appear in the third person; also pr_body_check_private, pr_body_check_voice and pr_body_check_counts (on/off)
pr_diagram_min_files: 3        # a PR over this many code files needs a mermaid diagram or `Diagram: n/a, <reason>`; default 3
pr_body_check_stack: on         # stacked PR needs a Stack section naming its base PR; also pr_body_check_order (Review order line over pr_review_order_min_files code files, default 3); on by default
pr_smells_repos: example/*     # GitHub owner/name globs (comma-separated) where pr-open.ts needs a recorded smells run (pr-smells.ts record); default none, so off
review_queue_cap: 4           # most open non-draft PRs awaiting review before dispatch stops new PR-producing work; default 4
rereview_gate: on             # prs-snapshot.ts --ready holds a PR with resolved review-bot threads until review-verdict.ts recorded a fresh-agent SHIP IT for its head; default on
stack_max_depth: 3           # most PRs in one stack; the PR board flags a deeper stack; default 3
stack_max_age_days: 5         # most days since a stack's oldest PR was opened; the PR board flags an older stack; default 5
pr_test_globs: <globs>         # comma-separated path globs counted as tests; omit for the built-in defaults
pr_config_globs: <globs>       # ... as config; pr_docs_globs: docs; pr_mechanical_globs: lockfiles, generated, vendored
twin_flow_repos: repo_a, repo_b # repos with the integration/release-candidate twin-PR flow; omit to turn the rule off
copilot_orgs: my-org          # comma-separated owners whose draft PRs the pr-watch event type requests Copilot review on; omit to request nowhere
git_emails: me@example.com     # comma-separated; the authorship check in branch-sweep.ts; omit to use each repo's user.email
protected_branches: main, release/*  # names or globs (`*` within one path segment, `**` across segments) branch-sweep.ts never lists; setting it replaces the default, which is main, master, staging, develop, release/*, staging/*, hotfix/*; add backmerge/* here to protect those too
sweep_merge_targets: repo_a=develop|staging  # per-repo branches a branch must be merged into; default develop (plus staging in twin-flow repos)
sweep_pr_days: 180             # days of merged PRs branch-sweep.ts reads as evidence; default 180
tracker_key_pattern: \bABC-\d+\b  # regex for tracker keys in a PR title or branch, listed by the pr-merged event; default is any ABC-123 shaped key
sweep_budget_seconds: 300     # the worktree sweep stops at the next repo boundary once over this many seconds, and names what it skipped; default 300
sweep_idle_minutes: 60         # a worktree must be untouched this long before branch-sweep.ts offers it; default 60
sweep_protect_symlink_dirs: ~/code/skills  # extra dirs whose symlinks mark a worktree as a live skill; ~/.claude/skills and <container>/.claude/skills always count
sweep_disposable_ignored: node_modules, .venv, dist, __pycache__  # ignored paths that do not keep a worktree; any other ignored file does (default shown)
env_store_root: ~/dev-env/.env-store  # where environment files live outside worktrees, as <root>/<repo>/<project>/; a worktree whose env files are symlinks into it is safe for the sweep to remove; default shown
podium_trusted_atlassian_hosts: example.atlassian.net  # Podium: Atlassian tenants whose ticket links reuse one tab per ticket (comma-separated); default none
event_dir: /path/to/events     # event loop: registry, state, digest; default <ledger_root>/Events, else ~/.local/state/the-maestro/events
notify_command: ["my-notifier", "--to-me"]  # event loop: argv (JSON array); the one-line summary is appended as the last argument; used only for watches added with --notify (reminders by default); omit for no notifications
watch_network_floor: 120       # event loop: fastest poll for network types (pr-checks, pr-watch, gh-run), seconds; can only raise the 120 floor
watch_local_floor: 30          # event loop: fastest poll for local types (inbox, reminder), seconds; can only raise the 30 floor
watch_type_intervals: pr-checks=240, inbox=90  # event loop: default interval per type, seconds; the floors still apply
inbox_command: ["my-inbox", "--unread"]     # event loop `inbox` type: argv printing one line per unread message, without marking them read; omit for none
container_root: /path/to/container  # the only directory roll and handoff will sweep for stale worktrees, and only when run from inside it; a leading ~/ is expanded; omit and the sweep refuses
agent_owned_repos: ~/tools, ~/notes  # repos the agent manages itself: the protected-branch stop does not apply there (commit to the default branch); every other git rule still does; omit for none
status_dir: /path/to/vault/Projects/<project>/Status # the Podium, priorities.md and companions; default <vault_root>/Projects/<project>/Status
priorities_max: 5            # the most priorities today's list may hold; `priorities set` and the Podium refuse more, and a list already over it can only shrink; default 5
obsidian_vault: MyVault # vault name in Obsidian links; default the folder name of vault_root
status_streams: Alpha, Beta # stream order on the Podium
status_repo_streams: api=Alpha, web=Beta # repo (short name) to stream for the PR tables; last resort after ledger evidence and stream-overrides.json
tracker_url_base: https://tracker.example.com/browse/ # tracker key links; omit for plain text
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

The environment variables that override single settings are `MAESTRO_OVERLAY`, `MAESTRO_GH_ORG`, `MAESTRO_GH_LOGIN`, `MAESTRO_PROJECT`, `MAESTRO_PROJECTS_DIR`, `LEDGER_ROOT`, `VAULT_ROOT`, `MAESTRO_PR_MAX_CODE_FILES`, `MAESTRO_PR_MAX_CODE_LINES`, and `MAESTRO_PR_TEST_GLOBS` / `MAESTRO_PR_CONFIG_GLOBS` / `MAESTRO_PR_DOCS_GLOBS` / `MAESTRO_PR_MECHANICAL_GLOBS`, `MAESTRO_TWIN_FLOW_REPOS`, `MAESTRO_GIT_EMAILS`, `MAESTRO_PROTECTED_BRANCHES`, `MAESTRO_SWEEP_MERGE_TARGETS`, `MAESTRO_SWEEP_IDLE_MINUTES`, `MAESTRO_SWEEP_PROTECT_SYMLINK_DIRS`, `MAESTRO_SWEEP_DISPOSABLE_IGNORED`, `MAESTRO_ENV_STORE_ROOT`, `MAESTRO_APPROVALS_REVIEW_DAY`, and the watcher overrides `MAESTRO_WATCH_MIN_INTERVAL`, `MAESTRO_WATCH_MAX_INTERVAL`, `MAESTRO_WATCH_QUIET_HOURS`, `MAESTRO_WATCH_QUIET_HOURS_MODE`, `MAESTRO_WATCH_QUIET_WEEKENDS`, `MAESTRO_WATCH_TZ`, and the event loop overrides `MAESTRO_EVENT_DIR`, `MAESTRO_NOTIFY_COMMAND`, `MAESTRO_INBOX_COMMAND`, `MAESTRO_WATCH_NETWORK_FLOOR`, `MAESTRO_WATCH_LOCAL_FLOOR`, `MAESTRO_WATCH_TYPE_INTERVALS`, the scripts shelf override `MAESTRO_SCRIPTS_DIR`, and the Podium overrides `MAESTRO_STATUS_DIR`, `MAESTRO_PRIORITIES_MAX`, `MAESTRO_STATUS_PAGE_URI`, `MAESTRO_OBSIDIAN_VAULT`, `MAESTRO_STATUS_STREAMS`, `MAESTRO_STATUS_REPO_STREAMS`, `MAESTRO_TRACKER_URL_BASE` and `MAESTRO_TICKET_NOTE_PATH`. A variable that is set to the empty string counts as set.

## Roots and names

| Setting | Used by |
|---|---|
| Container directory | repo routing, worktrees |
| Container project name | ledger paths `Projects/<name>/Journal/`; `project` / `CONTAINER_PROJECT` |
| `VAULT_ROOT` | tickets, `CONTEXT.md`, `DECISIONS.md`, `Plans/`, `Research/`, `Reviews/` |
| Obsidian vault name (for `obsidian://open?vault=`) | greeting.md, citations.md |
| `LEDGER_ROOT` | `journal.ts`, `ledger-index.ts`, `prs-snapshot.ts` |
| Claude transcript dir | `token-metrics.ts` (`CLAUDE_PROJECTS_DIR`) |
| Ticket skill | dispatch.md |
| Whether `roll` commits the ledger root (`ledger_git_autocommit`) | `journal.ts roll` |
| Weekday of the weekly approvals review (`approvals_review_day`, default Friday) | greeting.md, `journal.ts approvals` |
| Whether `prime` checks this skill's repo for updates (`update_check`) and fast-forwards it (`auto_pull`; unset is not off: `on`/`true`/`yes`/`1` and `off`/`false`/`no`/`0` count as answered in the environment, user file or overlay, anything else leaves it unset and `prime` asks; write it with `journal.ts autopull on\|off`) | `journal.ts prime`, `autopull`, greeting.md |
| Loop process patterns (`loop_patterns`) and whether `resume` calls `gh` (`resume_gh`) | `journal.ts resume` |
| Event loop: `event_dir`, `notify_command` (no default recipient: unset means no notifications; only watches added with `--notify` use it), `inbox_command`, `watch_network_floor`, `watch_local_floor`, `watch_type_intervals` | `event-loop.ts`, `scripts/event-types/inbox.ts` |
| PR watcher cadence (the event loop reads `watch_max_interval` as its back-off cap, plus the quiet-hours keys): `watch_min_interval`, `watch_max_interval`, `watch_quiet_hours`, `watch_quiet_hours_mode`, `watch_quiet_weekends`, `watch_tz` | `scripts/event-loop.ts` via `scripts/lib/cadence.ts` |

## Git identity and branch topology

| Setting | Used by |
|---|---|
| The user's git emails (authorship check; `git_emails`) | git.md, the standing brief block, `scripts/branch-sweep.ts` |
| GitHub login | PR scripts (read from `gh api user` unless `gh_login` / `MAESTRO_GH_LOGIN` is set) |
| GitHub org for the PR board | prs.md, `GH_ORG` in local-config.ts |
| Protected branches (`protected_branches`) | git.md, `scripts/branch-sweep.ts` |
| Branch-sweep merge targets (`sweep_merge_targets`), idle window (`sweep_idle_minutes`), PR look-back (`sweep_pr_days`), live-skill dirs (`sweep_protect_symlink_dirs`), disposable ignored paths (`sweep_disposable_ignored`) and the env store root (`env_store_root`) | `scripts/branch-sweep.ts`, `scripts/env-store-move.ts`, ledger.md |
| Default branch base, and per-repo exceptions | git.md step 1 |
| Owners pr-watch requests Copilot review for (`copilot_orgs`; unset means none) | `scripts/event-types/pr-watch.ts` |
| Repos that use the twin-PR flow (`twin_flow_repos`), and the names of their integration and release-candidate branches | git.md, prs.md |
| Deploy PR the user opens themselves | git.md step 4 |
| Review bots whose threads we may resolve | prs.md |
| PR size budget: code-file and code-line limits (`pr_max_code_files`, `pr_max_code_lines`) and the test, config, docs and mechanical path globs (`pr_*_globs`) | git.md, `scripts/pr-size.ts` |
| PR body rules: required sections (`pr_body_sections`), per-check switches (`pr_body_check_risk`, `_verify`, `_forbidden`, `_diagram`) the diagram file threshold (`pr_diagram_min_files`), the derivable-counts check (`pr_body_check_counts`), and the private-reference and voice checks (`pr_body_check_private`, `pr_body_private_words`, `pr_body_private_patterns`, `pr_body_check_voice`, `pr_body_voice_names`), and the smells gate (`pr_smells_repos`) | git.md#pr-body, `scripts/pr-body.ts` |

## Issue tracker

| Setting | Used by |
|---|---|
| Tracker and its MCP | greeting.md, ledger.md |
| Site (browse URLs) | greeting.md, prs.md |
| Default project key | greeting.md |
| Key in branch names, and any placeholder for local-only branches | git.md step 1 |
| Key in commit subjects | the standing brief block |

## Standing brief block, filled

[brief.md](brief.md#standing-brief-block--paste-once-into-every-brief) keeps the block generic with two `<…>` slots, `<user git emails>` and `<tracker key example>`. Their values come from the overlay's `config.md` (or your own values file), under a heading "Standing brief block, filled". Write one bullet per slot, `- \`<user git emails>\` → value`, in the user file or the overlay's `config.md`; [scripts/brief-block.ts](../scripts/brief-block.ts) reads them (user file first) and prints the filled block. Without an overlay, ask the user once and put the answer in the user file.

## Changing this file

A setting is added here when a rule elsewhere would otherwise name a person, company, repo, path, or key. Keep the rule where it was, reworded to say "from local-config", list the setting here, and put the value in the values file.

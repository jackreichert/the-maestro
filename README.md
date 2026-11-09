# Maestro 2.0

Modular agent workflows for a multi-repo workspace, with a dependency-free Node 24 persistence CLI, SQLite/FTS topic index, Claude Code status line, and Stop/PreCompact entry point. No plugin manifest or automatic installer. An [opt-in session event loop](./reference/events.md) handles selected PRs, reminders and command completion; actual harness delivery requires a separately approved installation and rehearsal.

## Skills

| Skill | Responsibility |
|---|---|
| [Maestro](./SKILL.md) | Dispatch, continuity, branch flow, PR budgets |
| [PR preparation](./pr-preparation/SKILL.md) | PR writing, feedback disposition, human-review gates, conflicts and readiness |
| [Planning](./planning/SKILL.md) | Project shaping, delivery plans, technical designs |
| [Mithril](./mithril/SKILL.md) | Coding discipline and phase-specific checks |
| [Xenophon](./xenophon/SKILL.md) | Local tickets and approved Jira publication |
| [Podium](./podium/SKILL.md) | Priorities, status, PRs, hash-linked questions |
| [Ledger](./ledger/SKILL.md) | Durable outcomes, decisions, topic recovery |
| [Library](./library/SKILL.md) | Verified repo onboarding and reusable knowledge |
| [Retro](./retro/SKILL.md) | On-demand review with selected improvement plugins |

## Muninn

**Muninn** is Maestro's combined memory system:

- **[Ledger](./ledger/SKILL.md):** what happened and why.
- **[Library](./library/SKILL.md):** reusable, verified knowledge.
- **[Podium](./podium/SKILL.md):** what matters now and what happens next.

Muninn is the umbrella name, not a fourth store or a separate workflow. Component names, commands, settings and storage paths stay unchanged.

## Setup

This is a configurable workflow bundle, not a zero-configuration app. No author-specific account, vault, service or permission is required or included.

| Capability | Requirements |
|---|---|
| Workflow skills | A harness that supports skills or explicit Markdown loading; use its own discovery/agent conventions |
| Muninn CLI | Node 24+ with `node:sqlite`; existing, separate writable ledger/vault directories and local settings. A vault is a Markdown directory, not an Obsidian service requirement |
| Automatic turn tracking and footer | Optional Claude Code integration; approve registration and rehearse in that harness. No equivalent is supplied for Copilot or other harnesses |
| Session events | Optional native Claude Code on macOS/Linux with `asyncRewake`; private local state root, separately approved hooks/ack permission and bounded idle coverage |
| GitHub PR operations/footer counts | Optional GitHub CLI (`gh`), authenticated to the installing user's account with access to the relevant repositories |
| Jira publication | Optional user-provided Jira tooling/access; local tickets need no Jira account |

No package installation is needed for the CLI. Select your own models, branch flow, paths and permissions. Tool/hook availability and terminal link rendering vary by harness/platform; the test suite is not certification of every environment.

Give an installation agent [SETUP.md](./SETUP.md). It confirms scope/permissions, registers the whole bundle, configures optional hooks, and checks discovery. It does not migrate old memory. See [persistence commands](./reference/persistence.md) for preparation, retries, recovery, and limits.

Root Maestro supports discovery; child skills currently have `disable-model-invocation: true`. Maestro explicitly reads them as needed. Linking the bundle does not expose each nested skill as an independent slash command; plugin packaging is separate future work.

The optional [Claude Code status line](./SETUP.md#4-optional-claude-code-status-line) displays current-repo PR actions, the user's total open PR count, session cost, context use, unresolved ledger questions, current-turn memory health, and a Podium link. It updates in the UI when assistant messages arrive; it does not modify reply text.

## Settings

[settings.json](./settings.json) contains public defaults. Local overrides live at `~/.config/the-maestro/settings.json`, outside the repo. Never store secrets, credentials, personal data, current priorities, or permissions in settings.

Existing installations using another config location must keep passing its absolute path with `--settings` until an approved migration. Changing the package/skill name does not move local configuration, registrations or storage.

Agents and the CLI merge defaults with local overrides recursively, preserving explicit `null`. An absent local file means defaults; unreadable/invalid files or unknown keys fail explicitly. CLI `--settings /absolute/file.json` selects a different override. Every persistence command requires existing, separate ledger/vault roots; `container_root` may remain unset. Budgets/branch flows guide agents, not automatic Git enforcement. Settings never authorize actions.

| Field | Meaning / validation |
|---|---|
| `schema_version` | Integer `1`; reject unsupported versions |
| `paths` | Exact keys in defaults; absolute directory paths or `null`. Resolve `~` before saving; ask for required unset paths. Check existence/access before use; don't create unasked |
| `pr_budget` | Positive integer limits; default hard cap is 1,000 changed code lines. Aim for 500. More than 1,000 in a PR requires explicit per-PR user approval; settings cannot raise the cap. Mechanical separation still applies |
| `repos` | Exact `owner/repo` keys; each value may contain only `branch_flow`, `environments`, `max_code_files` |
| `repos.*.branch_flow` | `maintained-staging` or `repo-specific`; verify actual maintenance and repo instructions before using. Missing means inspect/ask |
| `repos.*.environments` | Environment-name → branch-name strings. Labels, not proof of deployment |
| `repos.*.max_code_files` | Optional positive integer file-tier override; never raises the 1,000-line hard limit |

The `maintained-staging` flow is an opt-in preset, not a universal deployment policy. Confirm its branch and environment mapping with the user/repo before applying it. Otherwise use `repo-specific` and follow repo guidance; do not guess.

Example local overrides (placeholder repo only):

```json
{
  "schema_version": 1,
  "paths": {
    "vault_root": "/absolute/path/to/vault",
    "ledger_root": "/absolute/path/to/ledger",
    "container_root": "/absolute/path/to/projects"
  },
  "repos": {
    "example/sample": {
      "branch_flow": "repo-specific"
    }
  }
}
```

Podium owns changing priorities; ledger owns scoped decisions/permissions; local settings own installation paths and repo overrides. No settings file replaces those records.

## Verification and limits

Run `npm test` with Node 24; no dependency installation is needed. Synthetic tests cover deduplication, partial failures, conflicts, locks/concurrent writers, question removal, index/brief recovery, input guards and hook subprocesses. Installation additionally requires fresh-session discovery, actual hook delivery and recovery checks in the target harness.

Retros run on demand. Optional Claude Code hooks track each prompt, inject automatic checkpoint instructions, verify current-turn receipts at Stop, and request at most one repair when missing/failed. StopFailure flushes prepared work and marks interruption. Hooks never scrape conversations, synthesize missing knowledge or guarantee zero loss; Podium/library writes are relevant deltas only. Preserve old memory until the replacement passes an isolated harness rehearsal; never run competing writers/instruction sets in one session.

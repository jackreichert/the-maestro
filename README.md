# Maestro 2.0

Modular agent workflows for a multi-repo workspace, with a dependency-free Node 24 persistence CLI, SQLite/FTS topic index, and Claude Code Stop/PreCompact entry point. No plugin manifest, automatic installer, loops, or watchers. Actual harness delivery requires a separately approved installation and rehearsal.

## Skills

| Skill | Responsibility |
|---|---|
| [Maestro](./SKILL.md) | Dispatch, continuity, branch flow, PR budgets |
| [Planning](./planning/SKILL.md) | Project shaping, delivery plans, technical designs |
| [Mithril](./mithril/SKILL.md) | Coding discipline and phase-specific checks |
| [Xenophon](./xenophon/SKILL.md) | Local tickets and approved Jira publication |
| [Podium](./podium/SKILL.md) | Priorities, status, PRs, hash-linked questions |
| [Ledger](./ledger/SKILL.md) | Durable outcomes, decisions, topic recovery |
| [Library](./library/SKILL.md) | Verified repo onboarding and reusable knowledge |
| [Retro](./retro/SKILL.md) | On-demand review with selected improvement plugins |

## Setup

Give an installation agent [SETUP.md](./SETUP.md). It confirms scope/permissions, registers the whole bundle, configures optional hooks, and checks discovery. It does not migrate old memory. See [persistence commands](./reference/persistence.md) for preparation, retries, recovery, and limits.

Root Maestro supports discovery; child skills currently have `disable-model-invocation: true`. Maestro explicitly reads them as needed. Linking the bundle does not expose each nested skill as an independent slash command; plugin packaging is separate future work.

## Settings

[settings.json](./settings.json) contains public defaults. Local overrides live at `~/.config/the-maestro-redux/settings.json`, outside the repo. Never store secrets, credentials, personal data, current priorities, or permissions in settings.

Agents and the CLI merge defaults with local overrides recursively, preserving explicit `null`. An absent local file means defaults; unreadable/invalid files or unknown keys fail explicitly. CLI `--settings /absolute/file.json` selects a different override. Every persistence command requires existing, separate ledger/vault roots; `container_root` may remain unset. Budgets/branch flows guide agents, not automatic Git enforcement. Settings never authorize actions.

| Field | Meaning / validation |
|---|---|
| `schema_version` | Integer `1`; reject unsupported versions |
| `paths` | Exact keys in defaults; absolute directory paths or `null`. Resolve `~` before saving; ask for required unset paths. Check existence/access before use; don't create unasked |
| `pr_budget` | Positive integer limits; changed code lines cannot exceed 400. A wider file tier requires explicit user configuration; mechanical separation still applies |
| `repos` | Exact `owner/repo` keys; each value may contain only `branch_flow`, `environments`, `max_code_files` |
| `repos.*.branch_flow` | `maintained-staging` or `repo-specific`; verify actual maintenance and repo instructions before using. Missing means inspect/ask |
| `repos.*.environments` | Environment-name → branch-name strings. Labels, not proof of deployment |
| `repos.*.max_code_files` | Optional positive integer file-tier override; never raises the line limit |

For verified maintained-staging repos, flow remains `staging` → feature → `develop`, test on the staging platform, then the same feature → `staging` → `release/yyyymmdd.x` → `main`. Repo-specific flows come from repo guidance; do not guess.

Example local overrides (placeholder repo only):

```json
{
  "schema_version": 1,
  "paths": {
    "vault_root": "/Users/example/Documents/WorkVault",
    "ledger_root": "/Users/example/Documents/WorkLedger",
    "container_root": "/Users/example/projects"
  },
  "repos": {
    "example/sample": {
      "branch_flow": "maintained-staging",
      "environments": {"staging": "develop", "production": "main"}
    }
  }
}
```

Podium owns changing priorities; ledger owns scoped decisions/permissions; local settings own installation paths and repo overrides. No settings file replaces those records.

## Verification and limits

Run `npm test` with Node 24; no dependency installation is needed. Synthetic tests cover deduplication, partial failures, conflicts, locks/concurrent writers, question removal, index/brief recovery, input guards and hook subprocesses. Installation additionally requires fresh-session discovery, actual hook delivery and recovery checks in the target harness.

Retros run on demand. Hooks flush only prepared safe deltas; they never scrape conversations or guarantee zero loss. Preserve old memory until the replacement passes an isolated harness rehearsal; never run competing writers/instruction sets in one session.

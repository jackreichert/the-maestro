# Maestro 2.0

Modular agent workflows for a multi-repo workspace. **Skills-only release:** no plugin manifest, installer, persistence scripts, hooks, indexer, loops, or watchers. Memory contracts describe intended behavior, not functioning automation.

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

Give an installation agent [SETUP.md](./SETUP.md). It confirms scope and permissions, installs the whole bundle without breaking relative links, and checks discovery. It does not install unfinished hooks or migrate old memory.

Root Maestro supports discovery; child skills currently have `disable-model-invocation: true`. Maestro explicitly reads them as needed. Linking the bundle does not expose each nested skill as an independent slash command; plugin packaging is separate future work.

## Settings

[settings.json](./settings.json) contains public defaults. Local overrides live at `~/.config/the-maestro-redux/settings.json`, outside the repo. Never store secrets, credentials, personal data, current priorities, or permissions in settings.

**Agent-read contract, not a programmatic loader:** read defaults and the local file when present, merge objects recursively, and preserve explicit `null`. An absent local file means defaults; unreadable/invalid files or unknown keys require an explicit error and correction, not silent fallback. Explain unresolved required settings before using them. Applicable safety/repo rules win; settings never authorize actions.

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

Check JSON syntax, relative links, skill frontmatter, and Git whitespace. Installation additionally requires fresh-session discovery and selective-read checks in the target harness. These checks do not prove persistence, recovery accuracy, or runtime enforcement.

Retros run on demand. Stop/PreCompact automation requires separately implemented and tested writers. Keep the old memory path intact until the replacement passes recovery tests; never run competing Maestro instruction sets in one session.

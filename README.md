# Maestro

Maestro is a set of skills for a coding agent that works across repositories. It says what to pick up next, how to split a pull request, and when to hand work to another agent.

It also keeps a written memory outside the chat: decisions, what is in progress, and knowledge worth reusing. A new session reads that instead of replaying the old conversation. Optional hooks save the memory at the end of each turn and again just before the harness compacts the chat. The conversation can then stay short, which costs less, and the next session still knows where you left off.

You add this folder to a harness that loads skills. There is no account and no installer. Memory is Markdown plus a small Node CLI. The hooks are optional. The install steps supplied today are for Claude Code. You can also turn on [alerts](./reference/events.md) for selected pull requests, reminders, and finished commands.

## Skills

| Skill | Responsibility |
|---|---|
| [Maestro](./SKILL.md) | Dispatch, continuity, branch flow, PR budgets |
| [PR preparation](./pr-preparation/SKILL.md) | PR writing, feedback, human-review gates, conflicts, readiness |
| [Planning](./planning/SKILL.md) | Project shaping, delivery plans, technical designs |
| [Mithril](./mithril/SKILL.md) | Coding checks by phase |
| [Xenophon](./xenophon/SKILL.md) | Local tickets and approved Jira publication |
| [Podium](./podium/SKILL.md) | Priorities, status, pull requests, questions |
| [Ledger](./ledger/SKILL.md) | Decisions, outcomes, topic recovery |
| [Library](./library/SKILL.md) | Verified repo knowledge |
| [Retro](./retro/SKILL.md) | On-demand review. No schedule |

## Muninn

**Muninn** is Ledger, Library, and Podium. The name covers those three. It is not a fourth store. Commands, settings, and paths stay the same.

- **[Ledger](./ledger/SKILL.md):** what happened and why.
- **[Library](./library/SKILL.md):** reusable, verified knowledge.
- **[Podium](./podium/SKILL.md):** what matters now and what happens next.

Podium is the live board: priorities, active pull requests, open questions, blockers, next actions, and where to resume. Plans and handoffs link there. They do not keep a second status. Questions include context, options, a recommendation, and why. If no recommendation is sound, say which fact is missing and why it matters.

With the hooks on, the agent writes the turn's decisions and status before the chat is compacted or the session ends. The next session starts from Podium, then opens Ledger or Library only for the task it picked. Without the hooks, the same files still work. The agent writes them when the skill says to. Register the hooks in [SETUP](./SETUP.md). How a save is stored, retried, and checked is in [persistence](./reference/persistence.md).

## Setup

This bundle does not include an account, a vault, or any permission. Pick models, paths, and branch flow yourself.

| Capability | Requirements |
|---|---|
| Workflow skills | A harness that loads skills, or explicit Markdown reads |
| Muninn CLI | Node 24+ with `node:sqlite`, plus existing separate ledger and vault directories. A vault is a Markdown directory |
| Turn tracking, compaction hooks, footer | Optional. Approve registration and rehearse in the target harness. Claude Code is the integration supplied today |
| Session events | Optional native Claude Code on macOS/Linux with `asyncRewake`. Private local state, a separate approval, and bounded idle coverage |
| GitHub counts and pull-request commands | Optional `gh`, authenticated as the installing user |
| Jira publication | Optional. Local tickets need no Jira account |

The CLI has no package install. Give an installation agent [SETUP.md](./SETUP.md). It confirms scope, registers the bundle, and can add the optional hooks. It does not migrate old memory.

The root skill is discoverable. Child skills set `disable-model-invocation: true`. Maestro reads them when the work needs them. Linking the bundle does not make each child a slash command.

The optional [status line](./SETUP.md#4-optional-claude-code-status-line) shows open pull-request count, session cost, context use, unresolved questions, checkpoint health, and a Podium link. It does not change reply text. Podium lists active work, not every open pull request.

## Settings

[settings.json](./settings.json) holds public defaults. Local overrides live at `~/.config/the-maestro/settings.json`, outside the repo. Never store secrets, personal data, current priorities, or permissions there.

An existing install that uses another path must keep passing that absolute path with `--settings` until a migration is approved. Renaming the skill does not move config or storage.

The CLI merges defaults with local overrides and keeps an explicit `null`. A missing local file means defaults. An unreadable file, invalid JSON, or an unknown key fails. `--settings /absolute/file.json` selects another override. Persistence commands need existing, separate ledger and vault roots. `container_root` may stay unset. Budgets and branch flow guide the agent. They do not enforce Git, and they never authorize an action.

| Field | Meaning |
|---|---|
| `schema_version` | Integer `1`. Reject other versions |
| `paths` | The default keys only. Absolute directories or `null`. Resolve `~` before saving. Ask before creating a path |
| `pr_budget` | Positive integers. Default hard cap is 1,000 changed code lines. Aim for 500. Above 1,000 needs an explicit per-pull-request approval. Settings cannot raise the cap |
| `repos` | Exact `owner/repo` keys. Values may contain only `branch_flow`, `environments`, and `max_code_files` |
| `repos.*.branch_flow` | `maintained-staging` or `repo-specific`. Confirm the repo's real flow. Missing means inspect or ask |
| `repos.*.environments` | Environment name to branch name. Labels, not proof of a deploy |
| `repos.*.max_code_files` | Optional file-tier override. It does not raise the 1,000-line cap |

`maintained-staging` is opt-in. Confirm the branch map with the user or the repo. Otherwise use `repo-specific` and follow that repo. Do not guess.

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

Podium owns current priorities. Ledger owns decisions and grants. Settings own paths and repo overrides.

## Verification

Run `npm test` on Node 24. No packages to install. Tests cover conflicts, locks, recovery, and hook subprocesses. They do not prove live hook delivery. Rehearse that in the target harness before using a live vault.

Retros run only when asked. Keep the previous memory until a replacement has passed an isolated rehearsal. Do not run two writers or two instruction sets in one session.

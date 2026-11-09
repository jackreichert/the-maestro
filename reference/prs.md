# PR writing and lifecycle

Load when writing a PR title/description or reconciling merges. For preparation, open-PR checks, feedback, conflicts and readiness, read [PR preparation](../pr-preparation/SKILL.md). Follow [Maestro's branch flow and size budget](../SKILL.md) and repo templates.

## Write for the reviewer

- Review the complete diff against the intended base, not just the latest commit. Describe the actual change and user-visible outcome, not the work session. Separate implemented behavior, proposals and unverified claims.
- Title: concise, specific outcome in the repo's convention; include the ticket key when required. Avoid vague titles such as "updates" or "fixes".
- Body: lead with **why**, summarize meaningful behavior changes, then give reviewer navigation, validation, risks and rollback. Use the repo template; otherwise use this compact outline and omit irrelevant sections:

```markdown
## Why
Problem, impact and intended outcome. Link the team-accessible issue/spec.

## What changed
Behavior and boundaries; non-obvious tradeoffs. Name useful review starting points.

## Validation
Exact checks and actual results; explicitly state unrun checks and remaining gaps.

## Risks and rollback
Compatibility, data/config/deployment effects and reversal steps, when relevant.
```

- Add before/after screenshots for visible UI changes when useful; diagrams only when they clarify a flow. Link dependencies/twins and required merge order. Avoid file-by-file narration, pasted logs and boilerplate checklists claiming work not done.
- No private vault/bead IDs, local paths, sensitive data or AI attribution. Inspect the final title/body before publication and read back the draft afterward.

## Publication

- Draft PRs only, with authorized publication. Confirm repository, base/head and existing PRs before creating one; don't duplicate an existing draft. Prefer `gh` for GitHub operations; creating a PR never grants merge/promotion permission.
- Follow [PR preparation](../pr-preparation/SKILL.md) before publishing or claiming readiness; unresolved feedback or conflicts block merge readiness.

## Dependencies and merge reconciliation

- Link develop/staging twins and stacks; confirm each base and merge order. Same-feature staging promotion waits for develop-platform validation. Never equate a merged twin with completion of the other; recheck ancestry/head changes before acting.
- Once a merge is observed, verify merged SHA/target and reconcile related PRs, tickets, Podium, and ledger. Record testing/deployment evidence separately; merge is not deployment. Tracker writes need approval; cleanup follows [Retro](../retro/SKILL.md), never automatic deletion.

No PR poller or automated readiness tool is supplied; the preparation skill directs the agent's checks.

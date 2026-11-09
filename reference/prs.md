# PR writing and lifecycle

Load when writing a PR title/description or reconciling merges. For preparation, open-PR checks, feedback, conflicts and readiness, read [PR preparation](../pr-preparation/SKILL.md). Follow [Maestro's branch flow and size budget](../SKILL.md) and repo templates.

## Write for the reviewer

- Review the complete diff against the intended base, not just the latest commit. Describe the actual change and user-visible outcome, not the work session. Separate implemented behavior, proposals and unverified claims.
- Title: concise, specific outcome in the repo's convention; include the ticket key when required. Avoid vague titles such as "updates" or "fixes".
- Body: use the order below, adapting to repo templates. Keep acceptance criteria distinct from verified results; never imply unrun checks passed. Omit optional details that add no review value.

```markdown
<Paragraph 1: what this PR does, for whom and why; relevant issue/spec link.>

<Paragraph 2: what done looks like—checkable outcomes and important preserved behavior for this slice.>

## Reviewer guide
- Start here: linked entry points, logic, wiring and tests in review order, with brief reasons.
- Look closely: key decisions, invariants, failure paths and reviewer questions.
- When relevant: skim-safe generated/mechanical changes, exclusions and linked dependencies. Skim-safe never exempts author review; deferred work must not leave this slice unsafe.

## Validation
Commands, actual results, tested revision, unrun checks and remaining gates.

## Risks and rollback
Risk level/why, affected surfaces, worst credible failure/detection, compatibility or irreversible steps; reversal/flag and deploy order where relevant.
```

- Write compactly in the author's voice. Add screenshots, trimmed synthetic evidence or diagrams only when useful. Let GitHub show file/line/commit counts; avoid stale tallies, file-by-file narration, pasted logs and boilerplate claims.
- No private vault/bead IDs, local paths, sensitive data or AI attribution. Inspect the final title/body before publication and read back the draft afterward.

## Publication

- Draft PRs only, with authorized publication. Confirm repository, base/head and existing PRs before creating one; don't duplicate an existing draft. Prefer `gh` for GitHub operations; creating a PR never grants merge/promotion permission.
- Follow [PR preparation](../pr-preparation/SKILL.md) before publishing or claiming readiness; unresolved feedback or conflicts block merge readiness.

## Dependencies and merge reconciliation

- Link develop/staging twins and stacks; confirm each base and merge order. Same-feature staging promotion waits for develop-platform validation. Never equate a merged twin with completion of the other; recheck ancestry/head changes before acting.
- Once a merge is observed, verify merged SHA/target and reconcile related PRs, tickets, Podium, and ledger. Record testing/deployment evidence separately; merge is not deployment. Tracker writes need approval; cleanup follows [Retro](../retro/SKILL.md), never automatic deletion.

No PR poller or automated readiness tool is supplied; the preparation skill directs the agent's checks.

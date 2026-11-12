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

- PR bodies, comments and replies use the author's voice: "I", not "we"; preserve quotes and claim only work done. Add visuals or trimmed synthetic evidence only when useful. Leave counts to GitHub; avoid stale tallies, file-by-file narration, pasted logs and boilerplate.
- No private vault/bead IDs, local paths, sensitive data or AI attribution. Inspect the final title/body before publication and read back the draft afterward.

## Publication

- Keep commits coherent and passing: Conventional Commits, imperative subjects under about 72 characters, non-obvious rationale in the body. Put preparatory refactors first, tests with behavior, mechanical changes separately labeled "no behaviour change". Separate necessary blocking fixes first and explain them in the PR; ticket unrelated findings. Prefer roughly a screen of substantive change, not arbitrary splits; propose slicing tangled history only within Git permissions.
- Draft PRs only, with authorized publication. Confirm repository, base/head and existing PRs before creating one; don't duplicate an existing draft. Prefer `gh` for GitHub operations; creating a PR never grants merge/promotion permission.
- Follow [PR preparation](../pr-preparation/SKILL.md) before publishing or claiming readiness; unresolved feedback or conflicts block merge readiness.

## Dependencies and merge reconciliation

- Link develop/staging twins and stacks; confirm each base and merge order. Same-feature staging promotion waits for develop-platform validation. Never equate a merged twin with completion of the other; recheck ancestry/head changes before acting.
- Once a merge is observed, verify merged SHA/target and reconcile related PRs, tickets, Podium, and ledger. Record testing/deployment evidence separately; merge is not deployment. Tracker writes need approval; cleanup follows [Retro](../retro/SKILL.md), never automatic deletion.

No PR poller or automated readiness tool is supplied; the preparation skill directs the agent's checks.

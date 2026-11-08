# PR lifecycle

Load for PR preparation, feedback, readiness, or merge reconciliation. Follow [Maestro's branch flow and size budget](../SKILL.md); inspect repo rules. Read-only checks grant no write permission.

## Prepare and verify

- Draft PRs only, with authorized publication. Include context, reviewer guide, risks, rollback, actual validation, and relevant source links; diagrams only when helpful. No private vault/bead IDs, sensitive data, or AI attribution.
- Record repo, head/base branch and SHA, draft state, required checks, review decisions/approval SHAs, unresolved human/bot threads, mergeability, dependencies, and observation time. Missing/failed reads mean unknown, not ready.
- Before permitted pushes, check approval invalidation. Before readiness claims, re-read remote state: expected local/remote head match, checks on that head, threads, dependencies, mergeability. State remaining review/check gates. Ready to merge additionally requires all required checks/current approvals and no blocking threads/dependencies. Ready for user review is not ready to merge; neither permits promotion/merge.

## Feedback and dependencies

- Batch related review comments per repo/PR. Verify each against code; fix valid in-scope findings and rerun checks. Explain declined findings with evidence; broader changes need approval. Posting/resolving threads needs permission; never resolve human threads on their behalf.
- Link develop/staging twins and stacks; confirm each base and merge order. Same-feature staging promotion waits for develop-platform validation. Never equate a merged twin with completion of the other; recheck ancestry/head changes before acting.
- Once a merge is observed, verify merged SHA/target and reconcile related PRs, tickets, Podium, and ledger. Record testing/deployment evidence separately; merge is not deployment. Tracker writes need approval; cleanup follows [Retro](../retro/SKILL.md), never automatic deletion.

No PR poller or readiness tool is supplied. Acceptance when tooling exists: detect changed heads/stale approvals, failed or missing checks, unresolved threads, twin/stack blockers, and partial post-merge updates.

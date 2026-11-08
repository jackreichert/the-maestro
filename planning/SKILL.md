---
name: planning
description: "Use to shape a project, plan delivery, or write/review a technical design or tech doc: goals, evidence, options, decision gates, architecture, and verifiable phases."
disable-model-invocation: true
---

# Planning

Project shaping and technical design; [Mithril planning](../mithril/reference/planning.md) supplies coding checks. Scale detail to risk/uncertainty: small changes need a brief. Load needed [project-plan](./project-template.md)/[technical-design](./design-template.md) templates only; link shared content.

## Workflow

1. **Frame.** Problem, users, measurable outcome, constraints/invariants, non-goals, stakeholders, appetite/deadlines. Clarify material ambiguity; label proposals/assumptions.
2. **Research.** Vault context/plans, ledger beads, library first; then verify flows/prior art with Mithril. Record source revision/check; distinguish facts, hypotheses, rejected options, gaps.
3. **Design.** Compare viable options, including reuse/no change; recommend the simplest sufficient approach with tradeoffs. Describe boundaries, domain/data model, contracts, flows, side effects/failures, compatibility. Cover security/privacy, performance, observability, migrations/rollback where relevant; useful diagrams only.
4. **Challenge.** Check outcomes/invariants, risks/dependencies/unknowns. Decisions need context/options/recommendation, blocked work, one-way/two-way gates. Research facts; ask consequential choices. Time-box major unknowns as spikes.
5. **Sequence.** Map acceptance criteria (ACs) to checks and ordered, independently verifiable phases/PR slices. Name dependencies/owners/prerequisites, tests, rollout gates/rollback, next action. Estimate full delivery effort/uncertainty; never invent commitments.
6. **Review/handoff.** Can a fresh builder recover what, why, boundaries, checks, blockers? Fix gaps; independent review only for substantial risk. Approved slices → [Xenophon](../xenophon/SKILL.md); questions/priorities → [Podium](../podium/SKILL.md); decisions/evidence → [Ledger](../ledger/SKILL.md); verified reusable knowledge → library.

## Documents and approval

- Resolve vault/project (default `/Users/aryajack/Documents/AryaObsidian`). Check `Plans/`, `Planning/`, and existing `Projects/<repo>/CONTEXT.md` links first.
- Vault artifacts: `Plans/<repo>-<workstream>.md` (distinct suffixes for separate documents); phases: `Planning/<repo>/<workstream>/`. Cross-repo work needs an agreed project. Only templates live here.
- Reuse canonical docs; conclusions first, linked detail, preserved edits/history. Track status, source revisions, gates, approval scope, superseded decisions. Material changes reopen affected approvals/invalidate affected verification.
- Drafts/recommendations/tickets grant no implementation, publication, Git, or deployment permission. Record explicit approval/source and unresolved gates; read back writes/links, report partial failures.

Acceptance: fresh builder recovers goals, rationale, scope, dependencies, decisions, AC/check mapping without chat. Unverified assumptions/gates stay visible; plans don't prove implementation.

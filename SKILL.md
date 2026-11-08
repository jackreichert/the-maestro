---
name: the-maestro-redux
description: "Use to keep coding work moving across repositories with non-blocking delegation, compact context, durable continuity, and visible decisions."
---

# The Maestro 2.0

Version 2.0 defines the modular skill contracts; runtime persistence and hooks remain unimplemented.

Keep work moving through follow-ups, non-blocking delegation, durable memory, and visible priorities/decisions.

## Follow-ups

Treat new messages as "continue, and also do this" unless the user pauses/stops/switches. Answer, then resume; clarify conflicting or unclear requests.

## Dispatch

1. **Delegate selectively.** Keep short, tightly coupled, or decision-blocked work in-thread. Delegate substantial, bounded independent work, especially when it would crowd context.
2. **Recover and research.** Follow Memory below; search the library before code. Use a Haiku read-only scout for substantial independent prior-art searches across repo/shared packages/siblings. Return candidates, sources, contracts, differences, and search scope; "not found" is not proof of absence. Keep continuous traces in-thread.
3. **Plan.** Follow Craft; establish acceptance criteria (ACs), prior art, affected flow, risks, and verifiable PR slices. Sonnet handles standard work/ambiguity. Use Opus to decompose multi-system work, significant dependencies/design trade-offs, or otherwise hard-to-split tasks; skip it otherwise.
4. **Implement.** Haiku handles clear bounded tasks; Sonnet handles standard/ambiguous work and implements Opus plans. Escalate unexpectedly complex Haiku work to Sonnet with findings. Brief repo, goal, scope, permissions, findings/constraints, expected result, checks, stop condition, and investigation/output budget—not the parent conversation. Use `Plan` for read-only planning, `general-purpose` for multi-step work/edits, and fitting specialists.
5. **Prevent conflicts.** Parallelize independent tasks only. One writer per checkout; separate worktrees or sequence edits.
6. **Stay non-blocking.** Prefer background agents; handle follow-ups, then review results without polling. If unavailable, work in-thread rather than launching a blocking foreground agent.

## Continuation

- Reconcile on fresh starts, requests, and completion notifications; no unattended loop/watchers. `Stop` persists prepared changes, not external refreshes.
- Before each pick, re-read Podium priorities; verify ticket/PR liveness, dependencies, gates, permissions, ownership. After verified completion, advance within an authorized queue only; stop when exhausted, blocked, over budget, or out of scope. Ranking grants no permission.
- Follow [Podium recovery](./podium/SKILL.md) for interruptions. Relay verified outcomes/failures/next actions; never duplicate live work.

## Tickets

Read [Xenophon](./xenophon/SKILL.md) for durable work/incidental findings and creating, browsing, updating, closing, or pruning local/Jira tickets.

## Project planning

Read [Planning](./planning/SKILL.md) to shape projects or write/review delivery plans and technical designs. Use Mithril for coding checks; store authored plans in the vault. Approved slices become tickets; drafting grants no implementation permission.

## Memory

- Ownership: tickets own intent; [Podium](./podium/SKILL.md) owns priorities, streams, status, PRs, gates, and resume pointers; [Ledger](./ledger/SKILL.md) owns durable beads/checkpoints; [Library](./library/SKILL.md) owns reusable repo knowledge. Read the relevant skill; pass bead/page links in briefs.
- Fresh start/after compaction: read slim Podium, validate live ownership/state, then retrieve only the selected task's topic updates and library context. No competing ledger dashboard or always-loaded learnings.
- Each turn prepares safe changes; skip unchanged surfaces and save high-value decisions immediately. Podium changes need evidence and preserve user priorities; library patches need verified reusable knowledge. Decisions retain rationale, briefs track sequence coverage, and pages identify verified sources.
- Follow Ledger's checkpoint contract: proposed Claude Code `Stop` flushes prepared changes with stable retry IDs and separate acknowledgements. Preserve pending writes, reject conflicts, report partial failures; no transcript scrape or summarizing agent.
- Checkpoint before handoff. Slim `PreCompact` flushes prepared continuation only—no retros, cleanup, discovery, or PR polling. Hooks are not implemented.

## Acceptance criteria

- Planner—or in-thread builder before coding—extracts ACs from ticket/request: checkable outcomes, constraints, invariants, preserved behavior. Propose implicit criteria; clarify material ambiguity, never invent scope.
- Pair ACs/plan steps with checks; include them in implementation/review briefs and record clarifications in the existing ticket.
- Verify every AC, including cross-task outcomes. Task-level passes do not prove the whole outcome. Unmet/unverified ACs block completion; only the user changes scope.

## Branch flow

- Maintained `staging`: branch `feature` from it; PR `feature` → `develop`. Test there on the **staging platform** (`develop`, not branch `staging`), then PR the same `feature` → `staging`.
- Release: `staging` → `release/yyyymmdd.x` → `main`. No direct `staging` → `main` deploy PR.
- Check maintenance via repo guidance/release activity, not existence/age alone. Absent/stale `staging`: use documented repo flow; clarify uncertainty. Label branches versus environments explicitly in briefs/evidence/Podium.
- Creating branches, committing, pushing, or publishing PRs requires permission. Draft PRs only; user merges/promotes. No direct protected/shared-branch writes.

Read [PR lifecycle](./reference/prs.md) for PR preparation, feedback, readiness, and post-merge reconciliation.

## PR size

- Default: **at most 5 code files AND 400 changed code lines** (adds + deletes) against the intended base. Brief the budget; check the diff before opening.
- Exclude tests/config/docs; include migrations/SQL. Put lockfiles, generated/vendor files, and pure renames in separate mechanical PRs, which may carry tests/config/docs.
- Over budget: stop and propose ordered, independently passing PRs usable if the stack stops. Only explicit configured overrides apply: wider file tiers do not raise line limits; owner size waivers do not waive mechanical separation.

## Craft

Read [Mithril's core](./mithril/SKILL.md) across phases plus [planning](./mithril/reference/planning.md) for planners or [after-coding](./mithril/reference/after-coding.md) for builders (earlier for blocking smells). Load applicable runtime safeguards only. Include read instructions in briefs; agents do not inherit context. Reread core/current phase after context loss.

Default to builder self-review, not an agent per phase. Use independent review for substantial/risky changes: auth, data integrity, concurrency, public contracts, deployment. Return findings, evidence, and suggested moves—not manuals.

Non-trivial work: implement → review → fix → re-review, **at most three review rounds**, self or independent. Fix in-scope blockers; report others. Seek guidance with evidence for repeated blockers, exhausted cap, or broader scope; blocked/capped is not done. Brief this policy; skip ceremony for trivial work.

## Retro

Read [Retro](./retro/SKILL.md) on request only. Load selected improvement plugins, propose evidence-backed changes, and preserve approval boundaries. No scheduled runs or compaction chores.

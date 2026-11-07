---
name: the-maestro-redux
description: "Use to keep coding work moving across repositories with non-blocking delegation, compact context, durable continuity, and visible decisions."
---

# The Maestro

Keep work moving: handle follow-up requests without dropping the active task, delegate blocking work, preserve memory across context rolls, and keep an active view of priorities, progress, and decisions.

## Follow-ups

- Treat each new message as “continue the task and also do this” unless the user says to wait, pause, stop, or switch.
- Answer, then resume. Ask clarifying questions if requests conflict and intent is unclear.

## Dispatch

1. **Decide whether to delegate.** Keep short, tightly coupled, or decision-blocked work in-thread. Delegate substantial, bounded work that can proceed independently, especially if it would crowd the main context.
2. **Gather context.** Use a Haiku read-only scout for substantial independent prior-art searches across the repo, shared packages, and sibling implementations. Return candidates, source locations, contracts, differences, and search scope; "not found" is not proof of absence. Keep short lookups and continuous code traces in-thread.
3. **Assess and plan.** Read Mithril's core and planning add-on per Craft below; establish ACs, prior art, affected flow, risks, and verifiable slices within the PR budget. Use Sonnet for standard work and ambiguity. If the task spans multiple systems, has significant dependencies or design trade-offs, or is hard to decompose, ask Opus to turn the findings into sequenced, independently verifiable tasks. Otherwise skip Opus.
4. **Implement and brief.** Use Haiku for clear, bounded technical tasks; use Sonnet for standard or ambiguous implementation. For complex work, have Sonnet implement Opus's plan. If a Haiku task proves more complex or unclear than expected, hand it to Sonnet with the findings so far. Give each agent only the context needed for its task, not the parent conversation: repo, goal, scope, permissions, relevant findings and constraints, expected result, and verification. Use `Plan` for read-only planning, `general-purpose` for multi-step work or edits, and specialists when they fit.
5. **Prevent conflicts.** Parallelize only independent tasks. Never run concurrent writers in one checkout; use separate worktrees or sequence edits.
6. **Keep it non-blocking.** Prefer background agents so the user can keep interacting. Don't poll; handle follow-ups, then review results. Foreground agents block. If background execution isn't available, keep the work in-thread rather than launching a blocking agent.

## Tickets

Read [Xenophon](./xenophon/SKILL.md) when work needs a durable ticket, an incidental finding needs tracking, or the user requests browsing, updating, closing, pruning, or creating local or Jira tickets.

## Acceptance criteria

- The planning agent extracts ACs from the ticket/request: checkable outcomes, constraints, invariants, and preserved behavior. Propose implicit criteria; ask about material ambiguity, never invent scope. Without a planner, establish them in-thread before coding.
- Pair each criterion and plan step with verification; pass the relevant ACs and checks in implementation/review briefs. Record clarified criteria in the existing ticket when applicable.
- Check returned evidence against every AC, including cross-task outcomes. Unmet or unverified criteria block a done claim; only the user can approve scope changes. Do not let passing task-level checks substitute for the full outcome.

## PR size

- Default budget: **at most 5 code files and 400 changed code lines** (additions + deletions), measured against the intended PR base. Include the budget in coding briefs; check the actual diff before opening.
- Tests, config, and docs do not count; migrations, including SQL, do. Lockfiles, generated/vendor files, and pure renames belong in separate mechanical PRs, not mixed with code; they may carry tests/config/docs.
- Over budget: stop and propose ordered PR slices, each independently passing and usable if the stack stops there. Use only explicit configured overrides: an optional wider file tier cannot raise the line limit; an owner size waiver does not waive mechanical separation. Never invent exceptions.

## Craft

Read [Mithril's core](./mithril/SKILL.md) across phases. Planners additionally read its [planning add-on](./mithril/reference/planning.md); builders load the [after-coding pass](./mithril/reference/after-coding.md) after implementation, or earlier for a blocking smell. Load runtime safeguards only when applicable. Include core and phase-specific read instructions in agent briefs; agents do not inherit this context. After context loss, reread the core and current phase guidance.

Self-review by the builder is the default; phases do not require separate agents. Use independent review for substantial/risky changes (for example auth, data integrity, concurrency, public contracts, or deployment). Return specific findings/evidence/suggested moves to the builder, not full manuals.

For non-trivial changes, implement → review → fix → re-review, at most three review rounds, whether self- or independently reviewed. Fix in-scope blockers; report other findings. Seek guidance on repeated blockers, exhausted cap, or scope expansion; escalate on evidence. Blocked/capped is not done. Skip ceremony for trivial changes; include this policy in implementation/review briefs.

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
2. **Gather context.** When repo or documentation context is needed, use a Haiku read-only scout to find it. Have it return concise findings with source paths or links so later agents don't repeat the search.
3. **Assess and plan.** Use Sonnet for standard work and to assess complexity. If the task spans multiple systems, has significant dependencies or design trade-offs, or is hard to decompose, ask Opus to turn the scout's findings into sequenced, independently verifiable tasks. Otherwise skip Opus.
4. **Implement and brief.** Use Haiku for clear, bounded technical tasks; use Sonnet for standard or ambiguous implementation. For complex work, have Sonnet implement Opus's plan. If a Haiku task proves more complex or unclear than expected, hand it to Sonnet with the findings so far. Give each agent only the context needed for its task, not the parent conversation: repo, goal, scope, permissions, relevant findings and constraints, expected result, and verification. Use `Plan` for read-only planning, `general-purpose` for multi-step work or edits, and specialists when they fit.
5. **Prevent conflicts.** Parallelize only independent tasks. Never run concurrent writers in one checkout; use separate worktrees or sequence edits.
6. **Keep it non-blocking.** Prefer background agents so the user can keep interacting. Don't poll; handle follow-ups, then review results. Foreground agents block. If background execution isn't available, keep the work in-thread rather than launching a blocking agent.

## Tickets

Read [Xenophon](./xenophon/SKILL.md) when work needs a durable ticket, an incidental finding needs tracking, or the user requests browsing, updating, closing, pruning, or creating local or Jira tickets.

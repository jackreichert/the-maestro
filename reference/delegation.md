# Delegation

Walk top to bottom when Choose picks what to delegate. First match wins. Reassess when scope changes. If no suitable agent is available, stay in-thread.

1. **Stay in-thread.** The task is small, a continuous trace, tightly coupled edits, or an unresolved user decision.
2. **Read-only scout.** A substantial prior-art search across a repo, shared packages, or siblings. Return candidates, sources, contracts, differences, and search scope. "Not found" is not proof of absence.
3. **Configured deep agent.** Difficult debugging, architecture, or high-risk review.
4. **Configured fast agent.** Bounded research, routine implementation, or test triage, when the work is substantial and self-contained and gains from a separate context, independent judgment, or parallel progress.

Anything else stays in-thread. Do not stay in-thread only because the parent could do the work.

Follow the user's model preferences. If a fast task grows past its brief, escalate with findings.

Writers still follow Prevent conflicts: independent tasks only, one writer per checkout, separate worktrees or sequenced edits.

# Cleanup plugin

Load with [Retro](../SKILL.md) when selected. Inspect first; all removals require explicit approval and immediate revalidation.

- List completed/abandoned worktrees, branches, task-owned helpers, and scratch artifacts with owner, evidence, keep/remove reason, and recovery pointers. Use [Xenophon pruning](../../xenophon/SKILL.md) for tickets; archive, never delete their history.
- Keep protected/shared branches, live-owned or uncertain work, dirty/untracked/unpushed changes, and anything still needed by open work. Age alone proves nothing.
- Worktree removal requires confirmed merged/approved-abandoned work, no live owner or unsaved work, and updated Podium/ledger pointers. After approval, rescan and use `git worktree remove` without force; branch deletion is a separate approval, with tip revalidation.
- Remove only specific in-scope paths/processes; never broad roots or name-based process kills. Record actual applied/pending/failed results; failed cleanup is not completion. No unattended cleanup.

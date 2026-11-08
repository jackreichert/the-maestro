---
name: podium
description: "Use to maintain slim workspace priorities, streams, current status, open PRs, decision gates, and fresh-session continuation pointers in the vault."
disable-model-invocation: true
---

# Podium

Current coordination, not history. Podium owns priorities/workspace state; [Ledger](../ledger/SKILL.md) owns outcomes/decisions/rationale; tickets own intent/acceptance criteria; [Library](../library/SKILL.md) owns reusable knowledge. Link, don't duplicate.

## Slim landing page

- Resolve `VAULT_ROOT` (default `/Users/aryajack/Documents/AryaObsidian`). Entry: `Podium/README.md`; overflow: `Podium/Streams/<stream-id>.md`. Reuse existing records, not a second dashboard.
- Use [the template](./template.md). User-ranked streams: stable ID, outcome, repos, phase/status, blocker, next action, bead pointers. A bead is a ledger event ID/topic brief, not a new format.
- PRs grouped by stream, then repo: link, purpose, target branch, observed review/CI, dependency, next action/owner, checked time. Implementation, merge, QA, staging, production differ; unknown is not success.
- User questions by stream: associated ledger question hash; one-way (irreversible/costly) or two-way (reversible within stated limits) gate; context, options, recommendation/tradeoff, blocked work, beads, what was checked. Only real deadlines; reversibility grants no permission.
- Waiting on others: owner/follow-up trigger. Resume: selected stream/task, repo/worktree/branch, last verified step, verification owed, next step. Observe ownership separately; old pages cannot prove live leases.
- Target 500-1,000 tokens. Show overflow counts/stream links; never silently omit active work. Keep history/rationale in beads.
- Optional appetite: agreed time/cost budget, end/review trigger, cut-first scope. At the limit, ask to rescope, stop, or re-bet; never extend silently.

## Answer questions

- Persist a `question` bead; display its assigned event ID as the hash beside every landing/overflow question. Edits retain the ID, not a content hash.
- Accept `hash + answer`, quoted question/answer, or vault answers read on request. Match exact ID first, otherwise a unique contextual open-question match; clarify ambiguity, including answer-only text.
- Check current question/resolution. Identical repeats are no-ops; conflicts require reconciliation, never inferred reversal. Preserve unanswered questions/unprocessed edits.
- Save/read back a decision bead resolving the question, then remove it from all open Podium lists. Ledger retains history; no Podium resolution archive. Failed decision write keeps it open; failed removal stays pending for retry, even when the repeated answer is a no-op.
- Reassess blocked work within existing permissions; answering is not completing the resulting work.

## Updates and recovery

- Prepare changed fields with checkpoint ID, expected revision, source beads, observation times. Preserve unrelated edits/user priorities; never infer reprioritization.
- Follow [Ledger's checkpoint contract](../ledger/SKILL.md): `Stop` applies prepared updates under a shared Podium writer lock, checks revision, reads back, and acknowledges separately. Persist new beads first. Conflicts stay pending, not last-writer-wins; partial failure cannot imply other surfaces succeeded.
- Fresh start/after compaction: read landing page, select requested/already-selected task, retrieve only relevant bead updates/library context. Validate freshness, live ownership, worktree/branch, execution state; reconcile stale/missing state, never guess.
- Interrupted work: check last evidence, branch/head, worktree, dirty/untracked/unpushed changes, agent state/ownership. Preserve work; reconcile missing paths/uncertain owners. No automatic lock stealing, forced cleanup, duplicate dispatch; worktree creation/restarts need applicable authorization.
- Refresh relevant PR/external state on request or before acting; retain checked times and flag unavailable/stale evidence. No idle refresh/watchers.
- No whole-board rewrite/PR polling in hooks. Slim `PreCompact` flushes prepared continuation only; retros, cleanup, discovery, PR refresh are separate.

Draft only: no writer, hook, live vault page, or automatic PR sync.

Acceptance: fresh Haiku finds priority/next step, recovers rationale, and avoids live writers. Test ID/quoted/vault answers, ambiguity, repeats/conflicts, resolve-before-removal, overflow, stale state, partial failures when tooling exists.

---
name: ledger
description: "Use to checkpoint outcomes, retain decisions and learnings, or resume work and recover topics across fresh sessions and compaction."
disable-model-invocation: true
---

# Ledger

Topic memory and continuation evidence, not transcripts or a dashboard. [Podium](../podium/SKILL.md) owns priorities/current coordination; tickets own intent; library owns reusable knowledge. Link, don't duplicate.

## Records

- Resolve `LEDGER_ROOT` via [settings](../README.md#settings); ask if unset. Layout: `Events/YYYY-MM.jsonl`, `Topics/<id>/{topic.json,brief.md}`, `Pending/<session>/<checkpoint-id>.json`, derived `Index/ledger.sqlite`. Podium replaces ledger `Resume.md`. Topics span repos; repos are metadata. Migration from the old format needs an explicit plan.
- Append checkpoint envelopes; never rewrite history. Allocate checkpoint/event IDs before writes; reuse on retry. Envelopes receive globally increasing committed sequences (ingestion order, not occurrence time). Events carry UTC time, session/turn, repos, topic IDs, kind, concise summary, sources.
- Kinds: `progress`, `decision`, `finding`, `blocker`, `question`, `next`, `correction`, `checkpoint`. Include actual outcomes, decision rationale/rejected options, finding verification/uncertainty, and blocker/next dependencies. Podium questions use their `question` event IDs as stable hashes.
- Distinguish decisions/proposals and facts/hypotheses. Explicit references supersede conclusions, resolve blockers/questions, or replace next actions; chronology does not. `topic.json` projects identity, aliases, repos, and references from explicit envelope metadata. Reuse IDs through the index; don't manually overwrite generated metadata.
- No raw prompts/responses, secrets, or personal data; exclude `.env*`/`ssm-*.json`. Store safe evidence locations, not sensitive contents.

## Commitments and permissions

- User-stated commitments name trigger, action, owner, scope, evidence; clarify missing conditions. Temporary instructions name session/window/expiry; durable rules name topic/repo/workspace. Never broaden scope or infer permanence.
- Permissions name action/targets, grant source, one-off or explicitly standing duration, limits, expiry/revocation. Record one-off consumption; check scope before acting. History never overrides fresh-approval requirements.
- Answers append decision beads with explicit `resolves` question IDs; changed decisions use `supersedes`. Follow [Podium matching](../podium/SKILL.md); do not treat an answer as completion of the resulting work.
- Shared specs/notes: safe pointers with title, topic/repo, purpose, known revision/date. Reuse references, never sensitive contents. Temporary attachments need an approved durable location or explicit warning that future retrieval is not assured.

## End-of-turn checkpoint

- Prepare topic IDs, changed conclusions, decisions/reasons, evidence, blockers/next action, Podium fields, and verified library patches during the turn. Save high-value decisions immediately; later checkpoints reference them.
- One checkpoint tracks ledger/Podium/library operations as pending/applied/failed/not-needed, with stable operation IDs, targets, and expected mutable-page revisions. Empty turns get metadata-only checkpoints.
- Use [persistence commands](../reference/persistence.md) for `prepare`/`flush`. Claude Code `Stop` deterministically validates, deduplicates, assigns sequence, and appends under one writer lock. Prepared changes only: no transcript scraping, summarizing agent, discovery, PR polling, or unconditional rewrite.
- Persist beads before dependent vault updates; append failure blocks those dependents. Serialize mutable writes, reject stale revisions, preserve unrelated edits. Append and vault edits are not one transaction.
- Acknowledge each surface after read-back; surface failures and retain safe pending operations. Retries skip applied IDs. Index/brief failures never erase events. Keep outcome beads separate from application receipts; receipts and repeated hooks must not create continuation loops.
- `Stop` ends a response, not a task. Interrupted/error turns get failure checkpoints where supported; otherwise retain the last good checkpoint.

## Topic index and briefs

- Rebuildable SQLite/FTS indexes topic names/aliases/repos/references and events/sources; current-index queries avoid whole monthly logs. Views are not competing truth; failures are reported separately.
- `brief` projects every topic event and explicit relationship through a consistent snapshot with a hash-verified `covered_through_seq`. It is evidence, not synthesis; contradictions remain visible. Use [the template](./topic-template.md) for separate authored conclusions/rationale/constraints/questions/next action, without claiming verified coverage. Dates are not coverage; later events remain uncovered.
- Refresh at handoff, context roll, recovery, or when misleading, not every turn. Preserve uncovered events and contradictions.

Integrity/backup review belongs to [Retro](../retro/SKILL.md): validate records/references and recovery coverage; preserve source records independently of rebuildable indexes. No automatic backup, Git mutation, or history pruning.

## Recover a topic

Search names/aliases/repo; read brief, topic events after its watermark, then needed sources/library pages. Revalidate stale claims; report state, why, uncertainty, next action, and sources. Flag missing coverage; remember through pointers, not repeated prompt text.

## Resume a workspace

- Fresh start/after compaction: read Podium's slim packet, then only the selected task's uncovered events and needed library context. Briefs explain conclusions/rationale, not authoritative live status.
- Validate live leases, worktrees, branches, and state; never adopt another active writer's work. Reconcile missing/stale Podium against evidence without guessing user priorities.
- Checkpoint before handoff. Slim `PreCompact` flushes already-prepared continuation/work because compaction can precede `Stop`: no retro, cleanup, discovery, or summarizing agent. Register through [Setup](../SETUP.md) after approval.
- Autocompact thresholds belong to the harness; tune recovery cost/accuracy. Durable pointers, not conversation summaries, support recovery.

Acceptance: fresh Haiku recovers rationale and a newer correction; a fresh session resumes the correct task with minimal context, retrieves a learning, and avoids concurrent writers. Test duplicate flushes, failed writes, and missing capture separately.

Runtime tests use synthetic roots and hook subprocesses. Actual harness delivery and fresh-agent recovery remain unverified until an authorized rehearsal; no zero-loss guarantee.

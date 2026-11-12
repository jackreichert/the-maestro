---
name: ledger
description: "Use to checkpoint outcomes, retain decisions and learnings, or resume work and recover topics across fresh sessions and compaction."
disable-model-invocation: true
---

# Ledger

The durable history component of [Muninn](../README.md#muninn).

Topic memory and continuation evidence, not transcripts or a dashboard. [Podium](../podium/SKILL.md) owns priorities/current coordination; tickets own intent; library owns reusable knowledge. Link, don't duplicate.

## Records

- Resolve `LEDGER_ROOT` via [settings](../README.md#settings); ask if unset. Layout: `Events/YYYY-MM.jsonl`, `Topics/<id>/{topic.json,brief.md}`, `Pending/<session>/<checkpoint-id>.json`, derived `Index/ledger.sqlite`. Podium replaces ledger `Resume.md`. Topics span repos; repos are metadata. Migration from the old format needs an explicit plan.
- Append checkpoint envelopes; never rewrite history. `prepare` allocates missing UUIDs and collision-checked, case-sensitive four-character event `short_ref` values; retain its payload on retry. UUIDs remain canonical; `lookup` accepts either reference or full ID. Keep `event-references.json` with journal/pending backups: it reserves aliases across windows, including older events without changing their history. Envelopes receive globally increasing committed sequences (ingestion order, not occurrence time). Events carry UTC time, session/turn, repos, topic IDs, kind, concise summary, sources.
- Kinds: `progress`, `decision`, `finding`, `blocker`, `question`, `next`, `correction`, `checkpoint`. Include actual outcomes, decision rationale/rejected options, finding verification/uncertainty, and blocker/next dependencies. Podium displays question `short_ref` values; relationships always use canonical event IDs returned by `lookup`.
- Distinguish decisions/proposals and facts/hypotheses. Explicit references supersede conclusions, resolve blockers/questions, or replace next actions; chronology does not. `topic.json` projects identity, aliases, repos, and references from explicit envelope metadata. Reuse IDs through the index; don't manually overwrite generated metadata.
- No raw prompts/responses, secrets, or personal data; exclude `.env*`/`ssm-*.json`. Store safe evidence locations, not sensitive contents.

## Multiple windows

- Each window uses its actual harness session ID and current turn ID; never reuse another window's identity. Shared ledger entries may interleave normally: a new sequence or different session ID is not a conflict, corruption or reason to stop.
- Use session/turn IDs to identify your own pending writes and receipts; use topic/repo references to recover relevant knowledge from any session. Other sessions' receipts never acknowledge your turn.
- Reconcile new entries when resuming or before dependent actions, not by continuously polling. Coordinate only real overlap: incompatible decisions, competing edits or the same task/worktree. Do not overwrite or duplicate another window's work.
- Session identity is attribution, not an exclusive task claim; no task-lock registry is required. Existing short storage locks still serialize writes, and page revision checks still protect edits.

## Commitments and permissions

- User-stated commitments name trigger, action, owner, scope, evidence; clarify missing conditions. Temporary instructions name session/window/expiry; durable rules name topic/repo/workspace. Never broaden scope or infer permanence.
- Permissions name action/targets, grant source, one-off or explicitly standing duration, limits, expiry/revocation. Record one-off consumption; check scope before acting. History never overrides fresh-approval requirements.
- Answers append decision beads with explicit `resolves` question IDs; changed decisions use `supersedes`. Follow [Podium matching](../podium/SKILL.md); do not treat an answer as completion of the resulting work.
- Shared specs/notes: safe pointers with title, topic/repo, purpose, known revision/date. Reuse references, never sensitive contents. Temporary attachments need an approved durable location or explicit warning that future retrieval is not assured.

## End-of-turn checkpoint

- Automatically prepare/flush before finishing or compacting; save high-value decisions immediately without asking. Check unsaved conclusions/findings, decisions/reasons, permissions, evidence/results, blockers, pending choices and next actions: save events, revision-checked Podium patches for changed coordination, and verified reusable Library patches where relevant. No code change does not mean no memory change. Metadata-only is valid only when nothing relevant remains unsaved, never just to clear a hook. Compare saved content with the turn as well as receipts; receipt success proves neither capture nor board freshness.
- Before long waits/handoffs, save completed work, pending checks, command, checkout, tested revision (including uncommitted changes), relevant configuration, run ID, output location and next action. Append results when available; earlier saves never cover later outcomes.
- Use the actual session/injected turn ID; allocate new checkpoint/event IDs for new deltas, even within a turn. Retry with unchanged IDs/payloads. Metadata-only checkpoints are for genuinely no-change turns, never substitutes for substantive work.
- Verify each receipt's `errors` and separate ledger/page/index acknowledgements. Keep successful checkpoints silent in chat; the footer is enough. Report only unresolved failures or unverified saves in one short sentence with the blocker or next action, without routine IDs, sequences or saved-content recaps, unless asked. Preserve conflicts and unrelated edits; retain failed operations for reconciliation. A durable ledger append does not imply a successful page write or complete semantic capture.
- [Persistence commands](../reference/persistence.md) own schemas, ordering, retries and the [hook lifecycle](../reference/persistence.md#hooks-and-limits): current-turn coverage, one bounded repair, interrupted-turn health and earlier gaps. [Setup](../SETUP.md) owns approved registration. No transcript scraping, summarizing agent or automatic board/library rewrite.

## Topic index and briefs

- Rebuildable SQLite/FTS indexes topic names/aliases/repos/references and events/sources; current-index queries avoid whole monthly logs. Views are not competing truth; failures are reported separately.
- `brief` projects every topic event and explicit relationship through a consistent snapshot with a hash-verified `covered_through_seq`. It is evidence, not synthesis; contradictions remain visible. Use [the template](./topic-template.md) for separate authored conclusions/rationale/constraints/questions/next action, without claiming verified coverage. Dates are not coverage; later events remain uncovered.
- Refresh at handoff, context roll, recovery, or when misleading, not every turn. Preserve uncovered events and contradictions.

Integrity/backup review belongs to [Retro](../retro/SKILL.md): validate records/references and recovery coverage; preserve source records independently of rebuildable indexes. No automatic backup, Git mutation, or history pruning.

## Recover a topic

Search names/aliases/repo; read brief, topic events after its watermark, then needed sources/library pages. Revalidate stale claims; report state, why, uncertainty, next action, and sources. Flag missing coverage; remember through pointers, not repeated prompt text.

## Resume a workspace

Follow [Podium recovery](../podium/SKILL.md#updates-and-recovery) for live task, priority and ownership checks; retrieve only the selected topic's uncovered events and needed library context. Briefs are recorded evidence, not live status or permission. Checkpoint before handoff; autocompact thresholds belong to the harness.

Acceptance: a fresh agent recovers rationale and a newer correction; a fresh session resumes the correct task with minimal context, retrieves a learning, and avoids concurrent writers. Test duplicate flushes, failed writes, and missing capture separately.

Runtime tests use synthetic roots and hook subprocesses. Actual harness delivery and fresh-agent recovery remain unverified until an authorized rehearsal; no zero-loss guarantee.

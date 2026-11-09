# Persistence commands

Dependency-free Node 24 with built-in `node:sqlite`. [Setup](../SETUP.md) covers registration; [Ledger](../ledger/SKILL.md) defines memory ownership. Commands require existing, separate ledger/vault roots in [local settings](../README.md#settings). Runtime-created subdirectories are private; use owner-controlled roots. No live installation or old-format migration is implied.

## Prepare during the turn

Resolve the bundle/script and Node executable to absolute paths. Commands below use illustrative paths; replace them before execution.

```sh
node /absolute/bundle/scripts/memory.mjs prepare --settings /absolute/settings.json < /absolute/safe-checkpoint.json
node /absolute/bundle/scripts/memory.mjs flush --settings /absolute/settings.json session_demo
node /absolute/bundle/scripts/memory.mjs current --settings /absolute/settings.json session_demo
node /absolute/bundle/scripts/memory.mjs search --settings /absolute/settings.json "continuity"
node /absolute/bundle/scripts/memory.mjs lookup --settings /absolute/settings.json question_demo
node /absolute/bundle/scripts/memory.mjs recover --settings /absolute/settings.json topic_demo
node /absolute/bundle/scripts/memory.mjs brief --settings /absolute/settings.json topic_demo
node /absolute/bundle/scripts/memory.mjs rebuild --settings /absolute/settings.json
```

`prepare` accepts JSON on stdin, assigns missing checkpoint/event/page IDs and timestamp, validates, then saves a pending envelope. Retain its returned payload and reuse it exactly on retry; resubmitting input without assigned IDs creates new identities. Use the actual harness session ID. With turn tracking installed, use the turn ID injected by `UserPromptSubmit` or omit `turn_id`: the CLI binds it to the current tracked turn and rejects a different ID. `current <session>` retrieves that state without changing it. Without tracking, an explicit stable turn ID is required. If session identity is unavailable, report it; never guess. Flush important decisions immediately, and prepare/flush remaining safe deltas **before** responding or compacting, automatically rather than asking the user for routine memory updates. Genuinely no-change turns may prepare metadata-only envelopes; do not use empty arrays to bypass saving substantive work.

Illustration only: choose unique topic/event IDs for real records and reuse topic IDs thereafter.

```json
{
  "session_id": "session_demo",
  "turn_id": "turn_demo",
  "topics": [{
    "id": "topic_demo",
    "name": "Writer continuity",
    "aliases": ["continuity"],
    "repos": ["sample"],
    "references": ["Projects/sample/Knowledge/writer.md"]
  }],
  "events": [{
    "id": "question_demo",
    "topic_id": "topic_demo",
    "kind": "question",
    "summary": "Use one shared writer?",
    "sources": ["ticket:writer"]
  }],
  "pages": [{
    "id": "page_demo",
    "surface": "podium",
    "path": "Podium/README.md",
    "expected_sha256": null,
    "changes": [{"before": "", "after": "# Podium\nquestion_demo: Use one shared writer?\n"}]
  }]
}
```

## Envelope and page rules

- IDs: 1–128 letters/digits/underscores/hyphens, starting with a letter/digit. Envelope schema/version is `1`. Timestamp is UTC ISO with milliseconds, such as `2026-01-01T00:00:00.000Z`. Unknown fields fail.
- Topics require `id`, `name`, `aliases`, `repos`, `references`. Omit unchanged topics; an event may reference an already committed topic. Changes to topic metadata are explicit new envelope entries; `topic.json` is their generated projection. Manual metadata edits are preserved and block rebuild until reconciled.
- Events require `topic_id`, `kind`, `summary`, `sources`; optional `details` is a string containing rationale, rejected options, verification, uncertainty, permissions, or continuation evidence as appropriate. Optional `resolves`, `supersedes`, `replaces` are earlier event-ID arrays in the same topic. Questions resolve only through decisions; conflicting/repeated resolutions are not silently accepted. An identical repeated answer should reuse its existing checkpoint, not append another decision.
- Patches require `surface`, `path`, `expected_sha256`, `changes`. Hash the exact current UTF-8 file bytes with SHA-256; `null` means the file must not exist. Changes are literal `{before, after}` replacements, each with exactly one match. An empty `before` creates a new file only; unchanged/ambiguous patches fail.
- Allowed Podium pages: `Podium/README.md`, `Podium/Streams/<id>.md`. Library pages: `Projects/<repo>/{Knowledge,Runbooks}/<name>.md`, including nested concept folders; `verified: true` is required. Prepare derived README table/link edits explicitly; no library crawler/index builder is supplied.
- Removing a question requires page `resolves: ["<question-id>"]` and an earlier or same-envelope resolving decision. Identify **all** landing/overflow lists: receipts remain incomplete if the ID still appears in any supported Podium list. Exact/quoted/vault answer matching remains the agent's responsibility.
- A revision conflict never overwrites edits. Read/reconcile the current page, prepare a **new** patch with a fresh ID and `supersedes: "<failed-operation-id>"`, then flush. It must target the same page/surface. Only a successfully applied replacement retires the old operation; neither envelope is rewritten. If no patch is needed, don't invent a no-op: reconcile the pending operation explicitly before enabling hooks.
- Roots, settings files, and relative targets cannot be prohibited files; settings and in-root paths cannot be symlinks. Path checks assume owner-controlled directories, not hostile concurrent filesystem mutation.

Checkpoints are limited to 256 KiB UTF-8; CLI input to 1 MiB. Detection rejects common credential/personal-data patterns and prohibited-file references, **not all sensitive data**. Redact before preparing; the scanner does not make raw transcripts safe. Never feed transcripts, secret files, or real customer data.

## Durability and recovery

The writer locks ledger then vault, validates journal integrity/references, assigns a global ingestion sequence, and fsync-appends one envelope to `Events/YYYY-MM.jsonl`. Only afterward does it apply patches under the shared vault lock. Atomic replacements fsync and read back; their planned result hashes are saved before writing. Retry after a lost receipt accepts the matching result without reapplying; acknowledged patches preserve later edits. A crash followed by an unrelated edit produces a conflict, not a guessed success.

`Pending/<session>/<checkpoint-id>.state.json` independently records ledger, page and index outcomes. CLI `flush` returns each checkpoint's `turn_id`, ledger/Podium/library/index acknowledgements and question-removal status. Completed receipts remain for retries; they do **not** prove the latest turn was captured. Partial failures exit `1`, keep pending work, and expose errors. No broad rollback or automatic deletion.

Locks fail fast and are never stolen. On stale-lock or corrupt/torn-journal errors, stop competing writers, preserve evidence, verify ownership/process termination, and obtain approval for targeted reconciliation. Never truncate history or broadly remove lock/config directories. Applied replacements are marked `superseded`; use receipts rather than inferring application from append success.

SQLite/FTS is derived. A flush rebuilds once after all its unindexed checkpoints, then acknowledges each index outcome; repeated completed flushes skip rebuilds. Queries rebuild transactionally when journal file signatures change. Search covers topic names/aliases/repos/references and event text/sources, not whole-library contents. The footer's open-question count uses this same index; current-index queries don't parse monthly logs, while writes/rebuilds validate them. Rebuild failures preserve ledger truth and remain explicit, never stale success.

`lookup <event-id>` retrieves an exact question hash/event and directly related resolving/superseding/replacing events in that topic. Follow returned IDs or `recover` for later changes; do not guess from answer text or treat a pasted hash as permission.

`brief` creates a deterministic evidence projection with explicit relationships and a hash-verified sequence watermark, **not a model-written synthesis**. Refresh on handoff/recovery, not every turn. `recover` returns the verified brief plus every newer topic event; missing/edited briefs return full topic evidence instead. Authored synthesis may be kept separately, without claiming machine-verified coverage.

## Hooks and limits

`memory.mjs hook` accepts Claude Code JSON on stdin for `UserPromptSubmit`, `Stop`, `PreCompact`, and `StopFailure`. It uses event/session identity and Stop's `stop_hook_active` flag, never prompt contents, transcript paths, assistant messages or error details. `UserPromptSubmit` creates a random turn ID and injects checkpoint instructions with resolved CLI/settings paths through `hookSpecificOutput.additionalContext`.

Turn metadata lives in `Turns/<session>/current.json`; starting a new turn archives the preceding state in `Turns/<session>/<turn-id>.json`. These records contain identity, start time, coverage status, bounded-repair state and a count of earlier gaps, not conversation text. The next prompt never silently clears prior gaps. Per-session locks serialize lifecycle transitions; ledger and vault writes retain their existing shared locks. No automatic lock stealing or history pruning.

`Stop` flushes prepared work, then checks exact session/turn IDs against durable ledger and page/index receipts. Old checkpoints cannot cover a new turn. It requests one automatic checkpoint repair with blocking JSON on exit `0`; the persisted repair flag and `stop_hook_active` prohibit repeated blocking. Further failure exits `1` with explicit missing/failed health. Exit `2` is never used. An untracked turn can flush legacy checkpoints but exits `1` without claiming coverage; tracking starts on the next prompt. Metadata-only checkpoints prove the agent acknowledged a no-change turn, not semantic completeness.

`PreCompact` flushes without requesting continuation. `StopFailure` flushes already-prepared work and records interrupted coverage without blocking; it cannot recreate unprepared work. Claude Code ignores its output and exit status, so use persisted health for recovery. Other hook notices depend on harness visibility. Timeouts/process crashes can prevent a flush and leave a lock requiring manual reconciliation. Podium/library are patched only when relevant; checkpointing does not create or refresh a board automatically.

Automated tests use synthetic temporary roots and CLI hook subprocesses. Actual Claude Code delivery, interrupted API turns, fresh-agent recovery quality and existing-memory migration still require an authorized isolated harness rehearsal. No zero-loss promise, loops, watchers, scheduled retros, automatic backups, Git mutation or live PR synchronization.

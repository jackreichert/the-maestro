# Budget

Model tiers, agent choice, the standing brief's cost habits, session hygiene, and the PR watcher's
cadence. Read this before dispatching an agent, before a session starts running long, and before
changing how often the PR watcher polls.

## Choosing the Agent

Match the agent to the job; match the model to the difficulty.

Division of labour (the user, 2026-09-25): **Haiku gathers what can be checked; Sonnet or Opus decides
or writes code; the orchestrator (Opus) analyses, plans, and picks each worker's model by
difficulty.** The three tiers:

- **Haiku** — verifiable mechanical gathering: status sweeps, counts, test runs that report numbers,
  formatting, file-finding. Its output is checked, never trusted for a judgement call.
- **Sonnet** — mechanical code changes, well-specified implementation, conflict resolution, scouts
  that need to read and size code.
- **Opus** — design, root cause, security, and anything near PHI.

Always pass `model`
explicitly. An omitted model inherits the orchestrator's Opus, and a subagent's every tool call
re-reads its context, so inherited Opus is the expensive default. The tier names mean **the latest
model in that tier**: `opus`, `sonnet`, `haiku`. Use the aliases, never a pinned version, so this
table doesn't go stale when a new model ships. If a settings pin or an agent definition names an
older version, flag it.

| Job | Agent | Model |
|---|---|---|
| Status sweep (PRs, CI, Jira fields, ledger), counts, file-finding, test runs that report numbers | `general-purpose` or `Explore` | haiku |
| Locate code across many files, gather evidence | `Explore` | sonnet (haiku for a pure "where is X") |
| Query local data, run counts | `general-purpose` | sonnet (haiku when the query is given and only numbers come back; opus near PHI) |
| Implementation in one repo, well-specified; mechanical code changes; conflict resolution | `general-purpose` or `repo-worker` | sonnet |
| Formatting, renames, boilerplate with no judgement | `general-purpose` | haiku |
| Implementation with subtle correctness risk (cross-repo parity, concurrency, data migration, conflict-heavy rebases) | `general-purpose` | opus |
| System design, tradeoffs | `architect` (or the local equivalent) | sonnet |
| Hard architectural calls | `architect` | opus |
| Post-change review, plain prompt | `general-purpose` | sonnet (caught Blockers mithril missed on 2026-09-25) |
| Structured review pass | `mithril-review` | default; never the only gate on risky diffs |
| Duplication / dead code sweep | `refactor-check` | haiku |
| Stress-test a plan before committing | `skeptic` | sonnet |
| Deep single-axis review | a matching specialist reviewer | default |
| Continue work you already have context on | `subagent_type: "fork"` | inherits |
| Bot-thread review on a PR with multiple open threads | one agent per repo, batched across all of that repo's open threads | sonnet |

Every brief also carries a tool-call budget ("stay within ~N tool calls; report what's left").
Input tokens outweigh output about 200:1, so the number of calls drives cost.

Notes:

- `fork` inherits your full conversation context and always runs on your model. Use it when the
  brief would otherwise have to restate a lot of what you already know.
- Any other type starts **fresh** — it sees only the brief.
- Launch independent agents in a **single message with multiple tool calls** so they run
  concurrently.
- **Batch bot-thread rounds per repo** (lesson, 2026-09-27): when a repo has several open bot
  threads (Copilot, Aikido) across one or more PRs, dispatch one agent to work through all of them
  in a single pass, not a fresh agent per thread or per wake-up. See
  [loop.md#worked-example-2026-09-27](loop.md#worked-example-2026-09-27) for the measurement behind
  this.

## The standing brief's cost habits

The [standing brief block](../reference/brief.md#standing-brief-block--paste-once-into-every-brief)
carries several rules whose purpose is specifically cost, not correctness or safety. Why each one
is in the block (measured 2026-09-25, `scripts/token-metrics.mjs`):

- **Foreground waits.** Every background completion inside an agent can wake the orchestrator for a
  full-context turn — about 400k cache-read tokens each at today's context size. One rehearsal
  woke it about 15 times; 2026-09-25 logged 33 task-notification wake-ups against a prior median in
  single digits. A blocking loop costs the agent one tool call and the orchestrator nothing.
- **Capped reports.** A report stays in orchestrator context for the rest of the session and is
  re-read on every later turn. A 100-line report read 300 more times costs far more than it did to
  write. Detail belongs in a file the orchestrator opens only if it needs to.
- **Lean tool output.** Tool results enter the agent's context and are re-read on each of its later
  calls. A default Jira search returns full JSON with avatar URLs; `fields=key,summary,status` is
  the same answer at a fraction of the size.

The orchestrator follows the same rules for its own tool calls: `--json` + `--jq` for `gh`, `fields`
on Jira, counts not logs, and never a whole file read into its own context when an agent could
summarise it.

## Session hygiene

Every orchestrator turn re-reads the whole session, so per-turn cost climbs with session length.
Measured across all sessions to 2026-09-25 (`token-metrics.mjs --curve`): average cache-read per
turn is about 160k in a session's first 100 turns, 350k in turns 100–199, and 500k+ from turn 200.

**Roll to a fresh session** at end of day, or earlier once the current session passes **~200
turns** (roughly 25–30 prompts) or its read/turn tops **~400k**. `token-metrics.mjs` prints both
per session; check it at EOD and whenever the session has run long. Tell the user and let them start
the new session — you cannot do it yourself.

**Nudge before the threshold, not after it.** Added at the user's request, 2026-09-29. Run
`node scripts/token-metrics.mjs | grep <session-id-prefix>` whenever you relay an agent's result,
and at least every ~20 turns in between. Once the session reaches **~180 turns**, or its read/turn
tops **~350k**, tell the user it's time to roll up and refresh: give the turn count and the
read/turn, and offer to write the handoff and run `roll`. That leaves room to finish the handoff
before the 200 mark. Nudge once, then again at 200 if they haven't rolled, and after that only at
EOD. When the user asks for the nudge, log it with `journal.mjs log` so the request survives a
context compaction.

The handoff is what the fresh session reads, and it has five fixed headings, the ones
`journal.mjs handoff --stream <name>` scaffolds: **Tasks with status**; **Learnings, including what
was ruled out** (what was tried, too); **Artifacts**, as paths or `file:line`, never code blocks;
**Decisions awaiting** the user; **Next concrete action**. Anything decision-relevant that lives
only in chat goes under one of them before the roll: the 2026-09-25 experiment showed a fresh
session burns ~10x the tokens hunting for a fact nobody wrote down, and still misses it.

**Resume by reconciling, not trusting.** The fresh session checks `CURRENT.md` against `git`, `gh`
and `ListAgents` before acting (`journal.mjs resume` runs the parts a script can), then treats the
reconciled note as authoritative instead of redoing its work.

Lesson, 2026-09-27: a session ran to 316 turns without being rolled, and read/turn rose 13% for the
day as a result — see [loop.md#worked-example-2026-09-27](loop.md#worked-example-2026-09-27). The
threshold above already covers this; the miss was not rolling on time, not a wrong number.

## PR watcher cadence

`pr-watch.mjs` costs no tokens between ticks — it is a background poll, not a subagent — but every
tick that finds something still wakes the orchestrator for a full-context turn, so polling too
often is a real cost even though each individual poll is free. Cadence, updated 2026-09-27
(replaces the earlier 240s-default / 120s-while-active guidance — nothing below 300 is used
anymore):

- **Default: `--interval 600`** (10 minutes). `900` (15 minutes) is fine too. This is the normal
  daytime cadence, and what [greeting.md](../reference/greeting.md#a-greeting-is-a-request-for-the-board)
  starts the watcher with.
- **`--interval 300`** (5 minutes) only while a big list of threads is under active review — tighten
  the poll while someone is actually working through a batch, then relax it back to the default
  once that pass is done.
- **Nothing faster than 300, ever.** The lesson below is exactly why.
- **At night, poll every 30 minutes** (`--interval 1800`) until a set cutoff time, then stop the
  watcher entirely rather than continuing to poll while nobody is reviewing anything.

Lesson, 2026-09-27: a watcher polling every 2 minutes raised the day's wake-ups 16% against trend,
for no benefit the user acted on any faster than a 10-minute poll would have — see
[loop.md#worked-example-2026-09-27](loop.md#worked-example-2026-09-27). That measurement is what
moved the floor from 120s to 300s, and set the new daytime default at 600–900s.

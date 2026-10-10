# Budget

Model tiers, agent choice, the standing brief's cost habits, session hygiene, and the PR watcher's
cadence. Read this before dispatching an agent, before a session starts running long, and before
changing how often the PR watcher polls.

## Choosing the Agent

Match the agent to the job; match the model to the difficulty.

Division of labour (the user, 2026-09-25): **Haiku gathers what can be checked; Sonnet or Opus decides
or writes code; the orchestrator (Opus) analyses, plans, and picks each worker's model by
difficulty.** The three tiers:

- **Haiku** — read-only listings, sweeps, ticket closes, relays and playbooks, plus verifiable
  mechanical gathering: counts, test runs that report numbers, formatting, file-finding. Its output
  is checked, never trusted for a judgement call.
- **Sonnet** — builds and any write: code changes, well-specified implementation, conflict
  resolution, scouts that need to read and size code.
- **Opus** — only for executing reviews and decisions that find real bugs: design, root cause,
  security, and anything near PHI. It is not the default for routine work.

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
is in the block (measured 2026-09-25, `scripts/token-metrics.ts`):

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
Measured across all sessions to 2026-09-25 (`token-metrics.ts --curve`): average cache-read per
turn is about 160k in a session's first 100 turns, 350k in turns 100–199, and 500k+ from turn 200.

**Roll to a fresh session** at end of day, or earlier once the Session line says so. `token-metrics.ts`
and `journal.ts status --footer` measure two things against two limits: turns against `roll_turns`
(default 180) and mean cache-read per turn against `roll_read_per_turn` (default 350000). Either one
reaching a percentage of its limit trips the level: **`roll soon` at `roll_warn_pct` (default 60)**
and **`roll now` at `roll_at_pct` (default 90)**. You cannot start the fresh session yourself;
only Jack can compact or open one.

**What each level means (added at the user's request, 2026-10-05).** Check the Session line
whenever you relay an agent's result.

- **`roll soon`:** finish the relays already in flight, begin no new long dispatch chains, and say so
  in one line.
- **`roll now`:** run the roll yourself, without being asked: `journal.ts triage`, then `roll`,
  then `handoff --all --delta` (with `--learn`, `--next`, `--update-context` on the first one), and
  the worktree and branch sweep the roll already does. From then on open EVERY reply with a
  one-line reminder for Jack to compact (`/compact` or a fresh session) until the Session line is
  back under the warn level. Log the request once with `journal.ts log` so it survives a compaction.

**The roll is layerable.** Jack may not compact until well past `roll now`, so a roll can be run
again and again, each costing less than the last:

1. `roll` is idempotent: it regenerates the day's archive from the ledger and appends one `rolled`
   row, so running it twice loses nothing.
2. `handoff --delta` reads the newest `HANDOFF-<date>[b,c,...]-<stream>.md` and its
   `generated_at` marker. If there is none it writes the full handoff; otherwise it writes the next
   suffix (`HANDOFF-<date>b-<stream>.md`, then `c`...) holding only what the ledger gained after
   that marker: new items, completed items, new asks and the PRs they mention. A late roll costs a
   fraction of the first. The first one stays untouched; the delta names it in `delta_of`.
3. After a roll, keep logging work to the ledger as usual. The next roll, or the fresh session's
   `journal.ts prime`, picks it up; nothing waits for a compaction.

The handoff is what the fresh session reads, and it has five fixed headings, the ones
`journal.ts handoff --stream <name>` scaffolds: **Tasks with status**; **Learnings, including what
was ruled out** (what was tried, too); **Artifacts**, as paths or `file:line`, never code blocks;
**Decisions awaiting** the user; **Next concrete action**. Anything decision-relevant that lives
only in chat goes under one of them before the roll: the 2026-09-25 experiment showed a fresh
session burns ~10x the tokens hunting for a fact nobody wrote down, and still misses it.

**Resume by reconciling, not trusting.** The fresh session checks `CURRENT.md` against `git`, `gh`
and `ListAgents` before acting (`journal.ts resume` runs the parts a script can), then treats the
reconciled note as authoritative instead of redoing its work.

Lesson, 2026-09-27: a session ran to 316 turns without being rolled, and read/turn rose 13% for the
day as a result — see [loop.md#worked-example-2026-09-27](loop.md#worked-example-2026-09-27). The
threshold above already covers this; the miss was not rolling on time, not a wrong number.

## Hand-back discipline

Every agent's final message is re-read by the orchestrator on every later turn, so its length is paid for many times over. Measured on one orchestrator session on 2026-10-08, only 4 of 46 hand-backs stayed under 150 words (median 241, longest 1,010), and only 24 of 46 briefs carried the cap line at all; each agent also costs about 900 tokens of fixed harness text (launch ack, task notification, hand-back wrapper) that no brief rule can shrink.

- **Every brief ends with the standing block**, whose Report line says: full report to a file, a few lines back, plus the file path ([reference/brief.md](../reference/brief.md)). `brief-block.ts` prints it, and `journal.ts brief <id>` writes the whole brief as a file with the block already in it ([reference/brief.md](../reference/brief.md#the-brief-file--journaltsbrief-id)), so the cap is in every brief built that way. Nothing forces a brief through either command: a brief typed by hand can still leave the line out.
- **Long standing rules become files.** A brief names the path of a rule file instead of retyping a policy.
- **Relay the headline only.** The orchestrator passes on the headline and the path, never the report, and opens the file only when a decision needs something the headline lacks ([reference/dispatch.md](../reference/dispatch.md)). When a reply overran, say the cap was missed and tighten the next brief.
- **Enforcement status:** the cap is described, not enforced. The harness delivers whatever the agent writes, so compliance can only be measured after the fact (the plan proposes a weekly word-count metric in `token-metrics.ts`, not built).

## Compaction is the roll

Claude Code has no way to start a fresh interactive session on its own, so for the orchestrator compaction is the rollover. The design goal is that a compaction at any moment loses nothing: every decision, rule, ask and state change is written to the ledger the same turn it happens, and a hook rebuilds the working picture afterwards. The hooks are built and unit-tested (`scripts/hooks/`, `hooks.test.ts`) but are not installed for you: `node scripts/hooks/print-settings-snippet.ts` prints the settings to merge. Whether they behave on a live session has not been recorded here; the harness facts below are from the Claude Code docs.

**Harness behaviour (from the docs):**

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1 to 100 percent of the auto-compact window) can only lower the threshold; set it in the settings `env` block or the shell. It applies to the main conversation and to subagents. The window itself is set with `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow`, `/autocompact` or `--autocompact`. With the window variable set, the status line's `used_percentage` still measures against the full window.
- A `SessionStart` hook with the `compact` matcher (also `startup`, `resume`, `clear`, `fork`) can print text that is added to context. `scripts/hooks/session-start-compact.ts` does this for `compact` and `clear`: it prints `prime --source <source>`, `start-here` and the `library-brief` of each active stream (capped near 5k tokens), so the fresh context begins from the ledger. `precompact.ts` (PreCompact) writes a handoff, snapshots dirty worktree source and raises unledgered decisions first; `session-end-decisions.ts` runs the decision scan on SessionEnd.
- `PreCompact` (matchers `manual`, `auto`) can block a compaction; `PostCompact` carries `compact_summary`. Neither is documented to supply custom summary instructions.
- What survives compaction: the system prompt, project CLAUDE.md and unscoped rules and auto memory (re-read from disk), up to five recently modified files, and invoked skill bodies (5,000 tokens each, 25,000 total). Instructions given only in conversation are lost, and hook-added context is summarized rather than kept verbatim.

**Not available:** a hook cannot trigger `/compact` or `/clear` or open a new session, and hook inputs carry no live context percentage (only the status line script receives it).

**Still unverified:** the percent-to-window arithmetic of the override, whether `PreCompact` output can steer the summary, and whether a status line file plus a `UserPromptSubmit` hook can warn at a chosen percentage. Check these on a live session before relying on a number; until then the manual roll above stays the safety net.

**The success measure** is two orchestrator windows working in tandem on one ledger with no degradation. That has two parts: *cold-start equivalence* (a fresh window given only the hook's injection answers a fixed task set, including the hard-limit refusals, as well as a long-running window) and *tandem safety* (no duplicate dispatch of one item, no lost or overwritten ledger rows or handoffs, every event handled once by the window that owns it, each window's context under the threshold). Both parts depend on the same habit: log every decision the same turn it is made.

## PR watcher cadence

The `pr-watch` event type costs no tokens between ticks — it runs inside the event loop, a background
poll, not a subagent — but every tick that finds something still wakes the orchestrator for a
full-context turn, so polling too often is a real cost even though each individual poll is free. The
cadence is automatic (replacing the manual 2026-09-27 policy of picking `--interval` by hand),
implemented by `scripts/lib/cadence.ts`:

- **Base: 600s** (the type's `interval`). The loop only stretches it; busy periods keep that pace, they do not pull it in.
- **Quiet: back off** to 900s after an hour with nothing, then 1800s after two (capped by `watch_max_interval`).
- **Nothing faster than 300, ever.** The type declares a 300s floor, above the loop's 120s network floor,
  and no setting or `add --interval` goes under it. The lesson below is exactly why.
- **Quiet hours: 20:00-07:00 local** by default (`watch_quiet_hours`, `watch_tz`; weekends with
  `watch_quiet_weekends: on`). The loop skips the watch inside them (unless it was added with
  `--notify-overnight`), and `run` exits with "quiet hours" when no overnight watch remains; the next
  morning greeting restarts it.
- **Standing conditions wake once.** An approved-but-unmerged PR reports when it first appears or
  changes, not every tick, so a deliberately held-back PR no longer forces a wake per poll.

Unlike the standalone watcher it replaced, a push or a draft flip no longer tightens the pace: only events the
loop reports count as activity.

Lesson, 2026-09-27: a watcher polling every 2 minutes raised the day's wake-ups 16% against trend,
for no benefit the user acted on any faster than a 10-minute poll would have — see
[loop.md#worked-example-2026-09-27](loop.md#worked-example-2026-09-27). That measurement is what
moved the floor from 120s to 300s, and set the quiet-day baseline at 600–900s.

## One event loop instead of N watchers

Every ad-hoc watcher (a PR poller, a run watcher, a queue drain) wakes the orchestrator on its own
schedule, and each wake re-reads the whole session. `scripts/event-loop.ts` replaces them with one
loop over a registry of watches: a type's `diff()` decides what is a change worth waking for, the
cadence is the same `lib/cadence.ts` (300s floor, quiet hours), and a cheap runner following
[playbooks/event-loop.md](../playbooks/event-loop.md) wakes the orchestrator only on an actionable event.
Informational events go to a digest file and cost nothing until read.

Registered as a cost experiment, status **proposed** (the registry itself stays in the vault, see
[loop.md](loop.md)): the hypothesis is that wake-ups per day fall back toward the 7-day median on
days that used to run several watchers. Measure wake-ups per day and the count of actionable events
against the 7-day median over a few days with the loop in use; adopt it if wake-ups do not exceed the
median and no actionable event was missed, revert it if an event was missed or the loop's own runner
costs more than the wakes it saves.

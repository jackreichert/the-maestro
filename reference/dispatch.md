# Dispatch

Read the section you need: research and ticketing, two-stage dispatch, repo routing, agent choice,
external writes, verification loops, concurrency, following up, relaying results, and the
status-footer formatting rules. The brief itself is in [brief.md](brief.md).

## Research, Then Ticket

Two things happen before any agent is dispatched.

### Research first — but not by you

The anchors still matter. A brief without `file:line` makes the agent rediscover what someone
already knew, and a ticket that says "compliance tab won't hide" is worth less than one that says
"gated on a `compliance:read` permission at `Navbar.tsx:79-98`, no feature flag exists".

What changed: **you no longer do that research at the prompt.** Every grep you run is a turn the user
waits through. Delegate it. See [Two-stage dispatch](#two-stage-dispatch) — the scout does the
locating, you do the briefing.

### Then file a ticket

Use the `xenophon` skill for durable work. It writes one markdown note per ticket into
`$VAULT_ROOT/Projects/{repo-name}/Tickets/`, beside that project's `CONTEXT.md`.
If `VAULT_ROOT` is unset, ask where the vault is before filing anything. Do not guess a path.

```bash
node <xenophon-skill>/scripts/ticket.mjs new \
  --project <repo-name> \
  --title "..." --type bug --priority 2 \
  --body-file - <<'EOF'
<what you found, with file:line anchors>
EOF
```

Subcommands are `new | list | close | reopen | set | index`. The id prints on the last line.

**`--project` is mandatory here.** The script infers the project from `git rev-parse --show-toplevel`,
and this container root is not a git repository — so from here the inference fails or picks the
wrong repo. Always pass the target repo name explicitly.

Put the ticket id in the dispatch brief and in the report back, so the agent's findings have somewhere
durable to land.

### What earns a ticket

| Ticket it | Don't |
|---|---|
| A bug with a reproduction or a failing job | "Which repo is X in?" |
| Work that will span more than one session | A lookup answered in one grep |
| Something found in passing that nobody will otherwise fix | A question whose answer *is* the deliverable |
| A decision that needs to survive this conversation | Status checks on running agents |

One ticket per problem. If research turns up two unrelated problems, file two.

Record what was actually verified, and say when a lead rests on weak evidence — a ticket that
overstates its evidence costs more time than no ticket. Include hypotheses **ruled out**, so the next
person doesn't repeat the work.

Report it the way [Citing work](../reference/citations.md#citing-work) requires: an
Obsidian-openable link, the title, the priority, and the file path. Never a bare id. Do not commit
or push the vault unless asked.

**The vault ticket comes first; the external tracker is downstream.** File the vault ticket
automatically, without asking. An external-tracker issue (Jira, for example) is filed only on the
user's word: offer it in the report ("want a Jira for this?"), never file it on your own
initiative. Detail: the `xenophon` skill, *External trackers*. Tracker-specific rules: from the org overlay, if one is
configured (see [local-config.md](local-config.md#org-overlay)).

Note that vault ticket ids (`{repo}-002`) are **not** issue-tracker keys. If the repo's git-conventions guard wants
a tracker key in branch names, ask for that separately; don't substitute a
ticket id. Ledger ids (`k3mp`) are not tickets either — they live only in the journal.

Incidental findings (problems you notice while doing something else) get their own ticket too —
see [reference/citations.md](../reference/citations.md#incidental-findings-get-their-own-ticket).

## A new message is additive, not an interrupt

Messages arriving mid-turn are the normal way the user thinks out loud. **Default to: keep doing
what you were doing, and handle the new thing as well** — either alongside the current work or
straight after it, whichever your judgement says. Never abandon in-flight work because a new
request arrived, and never make the user say "continue what you were doing."

Judging when to run the new thing:

- **Alongside** — when it's independent of the current work. Dispatch it immediately so it runs in
  parallel; that's what this mode is for.
- **After** — when it touches the same files or repo as the work in hand, or when the current step
  is nearly finished and interleaving would just add confusion.

The one exception is a **genuine conflict**: the new message contradicts what you're doing, changes
its requirements, or says stop. Then stop, say plainly what you're abandoning and how far it got,
and follow the new direction. A correction is a conflict; a new task is not.

If a mid-turn message makes you unsure which it is, the tell is whether completing the current work
would waste effort or produce something the user no longer wants. If not, it isn't a conflict.

## Dispatch thresholds

| Handle inline | Scout first | Dispatch a worker directly |
|---|---|---|
| Already answered in this conversation | Any question needing a look at code | The user named the file *and* the change |
| A fact you can state without looking | Anything spanning multiple files or repos | A continuation — use `SendMessage` |
| Agent management — status, redirect, stop | Audits, reviews, cross-repo surveys | Anchors already gathered this thread |
| Ledger and ticket operations | Implementation, refactor, migration | |
| Relaying a finished agent's results | Parsing or analysing external documents | |

When in doubt, scout. The cost of an unnecessary agent is low; the cost of a blocked prompt is the
thing this mode exists to prevent.

## Two-stage dispatch

**The user must never wait on you.** Not for a grep, not for a file read, not for "let me just check
one thing". Every tool call you make at the prompt is a turn they are blocked in.

So the default shape of handling a question is **two agents, not one**:

### Stage 1 — the scout, dispatched immediately

The moment a non-trivial question arrives, before you have looked at anything, launch a
**read-only scout**. Then return to the user with a one-line ack. That is your whole first turn.

The scout's job is to *locate and size*, never to solve:

- Where does this live — `file:line` anchors.
- How big is it really — one file, one repo, or six?
- What is already known about it — an existing ticket, a `CONTEXT.md`, a prior survey.
- What would the real work need — which agent, which model, read-only or write, one repo or
  several, and does it need worktree isolation?

Use `Explore` or a `general-purpose` agent on a cheap tier. Scouts should be fast and disposable.
A scout that takes ten minutes has failed at being a scout.

**Scout cap: about 10 tool calls or 5 minutes.** Put it in the brief: "Stop at ~10 tool calls
and report what you found plus what's left." A scout that hits the cap reports; it doesn't push on.
If the leftover really matters, dispatch a second, narrower scout, or move to stage 2. Every tool
call re-reads the agent's whole context, so an uncapped scout is the expensive failure mode (one
ran to 99 calls on 2026-09-25).

**Ask the scout to recommend the stage-2 shape explicitly.** It has just read the code; it knows
better than you do whether this is a haiku rename or an opus architecture call.

### Stage 2 — the worker, dispatched by you

When the scout reports, **you** write the real brief and dispatch the worker. Not the scout — you.
The scout recommends; you decide. Three reasons that boundary matters:

- The [standing brief block](brief.md#standing-brief-block--paste-once-into-every-brief) and the git rules
  have to be in the brief, and they are yours to put there.
- You can see the whole board — other agents, other repos, one-writer-per-repo — and the scout
  cannot.
- Sometimes the scout's answer *is* the answer, and no stage 2 is needed. Recognising that is the
  cheapest outcome available and you cannot recognise it if the scout has already spawned someone.

### The honest cost

Two round-trips is slower in wall-clock than one for a question you could have answered in a
single grep. That trade is deliberate: The user's attention is the scarce resource, not elapsed time.
A question answered in four minutes while they keep typing beats one answered in forty seconds
while they wait.

But it is a real cost, so the inline floor below stays narrow and real.

### What still happens inline

Only these. Everything else gets a scout.

- Something already established in this conversation. Do not re-derive what you already know.
- A single fact you can state without opening anything.
- Managing agents — status, redirect, stop.
- Ledger and ticket operations.
- Reporting a completed agent's results.

Note what is **not** on that list: "just one grep", "let me check the file they named", "this will
only take a second". Those were the old inline cases and they are now scout work. The urge to
check one thing quickly is exactly the urge this section exists to override.

### When to skip stage 1

- The user named the exact file *and* the exact change. Dispatch the worker directly.
- A scout already ran for this thread and its anchors are still good. Reuse them.
- The work is a straight continuation of a running agent's task — use `SendMessage`, not a new
  scout.

## Repo Routing

Resolve the target repo before dispatching. Never let an agent start at the container root for
repo-scoped work — it will grep every project and return noise.

Discover the set each session; do not hardcode it. Immediate children that are git checkouts:

```bash
# From the container root
for d in */; do [ -d "$d/.git" ] && echo "${d%/}"; done
```

Routing procedure:

1. If the user names a repo, use it.
2. If the user names a domain and the mapping is obvious, use it.
3. If ambiguous across 2–3 candidates, dispatch **one** read-only `Explore` agent to identify the
   right repo, then dispatch the real work. Do not guess and do not ask the user first — locating
   code is agent work.
4. Only ask the user when the choice is a product decision, not a lookup.

Do not assume a repo's purpose from its name alone. A dispatched agent should confirm against the
repo's own README or entry point before making structural claims.

## New repo discovery

A repo is **new** when `$VAULT_ROOT/Projects/{repo-name}/CONTEXT.md` does not exist. If `VAULT_ROOT`
is unset, ask for the vault path before looking. First contact
with a named repo is discovery, not a silent dispatch.

Do both, in that order:

1. **From the repo** — README, how it is built and tested, the layout of the top level, any
   documented branch or deploy flow. Enough to brief someone; you are not mapping the whole tree.
2. **From the user** — what the code cannot tell you. Ask only questions whose answers would
   change how you dispatch: what this repo is *for*, constraints, what is off-limits, how it
   relates to the other projects in this container, anything they already know that a stranger
   would waste a session rediscovering.

Then write `$VAULT_ROOT/Projects/{repo-name}/CONTEXT.md` so the next session does not start from
zero. Goals, a `## What done looks like` section (the project's observable finished state), current
state, constraints, open questions, last-updated date, and links to supporting documents — one
canonical home per fact; do not duplicate the README.

The project folder has a fixed shape; create the parts as they are needed, not up front:

| Path | Holds |
|---|---|
| `CONTEXT.md` | The entry point: goals, done state, current state, constraints, open questions, links |
| `DECISIONS.md` | Dated decisions with rationale, rejected alternatives, and consequences |
| `Plans/` | Active plans and runbooks, each with a descriptive name and an explicit status |
| `Research/` | Evidence and exploration that inform decisions but don't replace them |
| `Tickets/` | One note per ticket, via `xenophon` |
| `Archive/` | Completed or superseded material, linked to its replacement |

Test for what belongs in the vault rather than the repo: if the document would still matter after
the repo disappeared, it goes here. Version-specific docs (`README.md`, the repo's `CLAUDE.md`)
stay in the repo.

If `CONTEXT.md` already exists, **read it** before researching or dispatching, and update it
when discovery turns up something that should outlive this conversation.

Discovery does not replace the work they asked for. Do enough to orient, file the notes, then
continue — ask the user in the same turn if you need them, rather than blocking the request
behind a questionnaire.

## Choosing the Agent

Matching the agent to the job and the model to the difficulty is cost material now — the tier
table, the division of labour, and how `fork` differs from a fresh agent are in
[cost/budget.md#choosing-the-agent](../cost/budget.md#choosing-the-agent). Read it before writing a
brief. The one rule that stays here because it's about dispatch shape, not cost: launch independent
agents in a **single message with multiple tool calls** so they run concurrently.

## The Dispatch Brief

The brief and the standing brief block live in [brief.md](brief.md).

## External writes have one owner

A write to a system other people read — a Jira issue, comment, or transition; a GitHub PR comment,
review reply, or thread resolution; a Slack message — cannot really be taken back. **One named
agent owns each external write, end to end**, and it is the agent the brief authorized.

- The orchestrator either makes the write itself, after the user approved it, or dispatches exactly
  one agent whose brief names that write.
- **A helper agent never delegates an external write to a sub-agent or fork.** Delegation loses
  the approval context, and two agents holding the same write produce duplicates (two comments, a
  transition applied twice) that someone has to clean up by hand. The standing brief block carries
  this rule so the agent sees it too.
- If a helper finds it needs a write its brief didn't authorize, it reports back and asks; it does
  not improvise one.

## Verification loops

A verification — a rehearsal, a dry run, a shadow run, a parity comparison, a test suite against
real data — exists to find problems before they ship. **When a verification finds a real problem,
the default next step is a draft fix PR and a re-run of the same verification**, not a report and a
wait.

- Once the user has approved this loop for a given verification, run it without asking each time:
  find → ticket → draft fix PR (per [git.md](git.md)) → re-run → report. Without that approval,
  propose the loop in one line and wait.
- A "real problem" is a regression or a defect with a concrete failure. An expected diff, a known
  accepted gap, or a flaky environment is not; say which it was.
- Re-run the verification that found it, on the same inputs where possible, so the result is
  comparable. Report the before and after side by side.
- **A change to a tested set voids "tested".** When a verification passed on an exact set of PRs (a
  merge set), record each PR's patch id at the tested commit:
  `git diff <base>..<head> | git patch-id --stable`. At merge time, run it again on the current head.
  Equal means tested-equivalent (a rebase onto a moved base, say). Different means re-run, unless
  the change between the two heads touches only docs or tests; then say which it was, with both
  commits. This is the one home of the rule; `release-rehearsal` applies it to go-live sets.

Go-live work built on these loops (gated readiness plans, merge sets, rollback runbooks) has its
own skill: `release-rehearsal`. Org-specific go-live steps come from the org overlay, if one is configured (see [local-config.md](local-config.md#org-overlay)).

## Concurrency Safety

The failure mode of this workflow is two agents editing the same repo at once.

**The main checkout is the default. Worktrees are for conflict, not for hygiene.**

Do not reach for a worktree just because you can. A fresh worktree has no `node_modules`, so a JS
repo needs a full `npm ci` before anything can run — minutes of setup, a second dependency tree to
keep healthy, and a second thing to break. The user also commits from the main checkout; work parked
in a worktree is work they have to go and find. Isolation is worth those costs when there is a real
collision, and only then.

- **One writer per repo checkout.** Before dispatching a writing agent, check `ListAgents` for an
  existing writer in that repo.
- **Readers are unlimited.** Read-only analysis agents may overlap freely, including with a writer.
- **Use a worktree when the repo is busy — then don't queue and don't refuse.** Busy means one of:
  another agent is already writing that repo; the main checkout carries uncommitted work a second
  agent would tangle with; or the work is long-running and would block the user's own use of the
  checkout. Give the new agent `isolation: "worktree"`, or create one yourself and point the agent
  at that directory:

  ```bash
  git -C <repo> worktree add <container-root>/.worktrees/<repo>-<TICKET> -b <branch> <base>
  ```

  Blocking new work because a repo is occupied defeats the whole point of this mode. Parallel
  workstreams in one repo are normal; isolate them rather than serialising them.

- **git-crypt repos need the key linked into the worktree.** A new worktree of a git-crypt repo
  can't decrypt until the key directory is linked into `.git/worktrees/<name>/git-crypt/keys`
  (from the main checkout's `.git/git-crypt/keys`). **That step is the user's**: it touches key
  material, so ask them to do it and wait, rather than doing it yourself or working on the
  encrypted files as-is. Which repos are git-crypt: from the org overlay's
  repo notes, if one is configured (see [local-config.md](local-config.md#org-overlay)).
- **Always tell the user a worktree is in play**, and give its path — the changes will not appear in
  the main checkout, and `git status` there will look untouched.
- **Worktrees isolate files, not everything else.** They share one `.git` (so branches, stashes and
  reflog are common) and they share external state — databases, ports, containers. Two agents
  running the same integration suite against the same test database will still corrupt each other's
  results. Isolate the *files* with a worktree; sequence the work when the conflict is over shared
  external state.
- **Clean up.** A worktree leaks past the next session. Remove it once its branch is
  merged or abandoned: `git -C <repo> worktree remove <path>`.
- **Never** dispatch two agents to edit the same file, even in separate worktrees — they will
  produce conflicting branches. Sequence those.

## Following up on running agents

The quick table for status/redirect/stop is in `SKILL.md` and covers the common case. Two extra
rules:

- Route follow-ups on existing work through `SendMessage` — the agent keeps its context, so a
  follow-up costs far less than a fresh agent re-deriving everything. A new `Agent` call is for new
  work, not for refining work already in flight.
- Never fabricate, predict, or pre-summarize a pending agent's results. If the user asks before the
  notification lands, the honest answer is that it's still running.

## Relaying Results

**The agent's final report is not shown to the user.** If you don't relay it, they never see it.

**Batch the relays.** Each reply re-reads the whole orchestrator context, so a turn per
notification is the costliest habit in this mode. Measured: batching cut cache reads by about 66%
and cost by about 28%, with output unchanged.
- When several agents are live, hold small completions (a correction applied, a runbook tweak, a
  duplicate "finished" notification) until the next substantive report, or the next user message.
  Relay them together.
- Relay at once only what changes what the user does next: a blocker, a finding they have to act
  on, a failure, a decision request, or the last live agent finishing.
- A duplicate completion notification for an already-relayed agent gets a one-line reply at most.
  Never repeat the report.

When a notification arrives:

- If the report ran past ~20 lines, relay the essentials and say the brief's cap was missed, so the
  next brief can be tighter. Do not paste it on.
- Lead with the answer or the outcome, not the process.
- Keep `file:line` citations — they're clickable.
- Surface disagreements and gaps rather than smoothing them over. An agent reporting "this can't be
  done with current primitives" is the most valuable thing it can tell you; don't soften it.
- Don't take an agent's output at face value when it contradicts something you verified yourself.
  Say so and reconcile.
- State plainly what was **not** done, and why.

### Check before you relay

A status is only as current as its source, and two sources go stale quietly.

- **A research note more than a day old.** Before you relay what it says is done, open, merged or broken, check it against the code on `main` (`git log`, the file itself) and against facts already in this session's ledger. Where they disagree, relay the disagreement, not the note.
- **A subagent report.** Same check for any claim you are about to pass on that you did not see yourself: a PR state, a test result, a file's contents. A report that contradicts the ledger or `main` is reconciled before it is relayed.
- **Research notes carry their own freshness.** A note in `Research/` records the commit sha it was verified at (`verified-at: <sha>` in its front matter) and, when a newer note replaces it, a `superseded-by: [[newer note]]` link. A note with no `verified-at` counts as unverified; one with `superseded-by` is never relayed from.

## Status Footer

**End every reply with the live agent roster and the ledger count.** Background work is invisible by design — the user
cannot see what is running unless you tell them, and "I forgot to mention an agent was still
working" is the failure mode this footer exists to prevent.

Placement: after the response body, before any sign-off.

Call `ListAgents` to build it. **Never write the footer from memory** — an agent you dispatched
three turns ago may have completed, been killed, or still be running, and only `ListAgents` knows
which. Memory here produces confident lies about work state.

Format — one line per agent, most recently dispatched last:

```
**Agents:** `trace-client-id` running 4m · `map-amada-uat` completed
**Ledger:** 4 done today · 2 in flight · 1 awaiting you
```

The ledger line comes from `journal.mjs status`, not from memory. One line, counts only — the detail
lives in `CURRENT.md`. Omit it only when the ledger is completely empty.

When more than two are live, use a list instead:

```
**Agents**
- `trace-client-id` — running 4m — billing-api
- `audit-permissions` — running 11m — admin-ui
- `map-amada-uat` — completed
```

When nothing is running, say so in one line — the absence is itself information:

```
**Agents:** none running
**Ledger:** 4 done today · 0 in flight · 1 awaiting you
```

Rules:

- Use the agent's task description, never its internal `agentId`. IDs are harness plumbing and
  leaking them into the transcript is noise the user cannot act on.
- Include elapsed time for anything `running` — it's how the user judges whether to keep waiting.
- Include the target repo when more than one agent is live, so overlapping work is visible.
- Report `killed` or `failed` states explicitly rather than silently dropping them. A stopped agent
  that the user thinks is running is worse than no agent.
- The footer reports state; it does not summarize findings. A completed agent whose results you
  have not yet relayed belongs in the body, not compressed into the footer.
- Keep it to one line per agent. This is a status bar, not a report.

## Waiting on an outside event

When work depends on something outside the session (a PR's CI, a GitHub Actions run, review activity,
new messages), do not write a one-off watcher and do not make an agent poll. Register a watch with
`node scripts/event-loop.ts add --id <id> --type <type> --target <target> --report "<what you want back>"`.
One loop polls every registered watch, and a cheap runner follows
[playbooks/event-loop.md](../playbooks/event-loop.md) and wakes you only for an actionable event, so
waiting costs one wake per event, not one per watcher. Each type polls at its own pace (override with
`--interval S`; network types never faster than 120s). For "remind me at <time>" register a `reminder`
watch (`--type reminder --target <ISO 8601 UTC> --report "<text>"`). A watch notifies the user only if
added with `--notify` (reminders do by default, `--no-notify` turns it off; inbox never). The event types and what each reports are in
`playbooks/event-types/`; a new kind of wait is a new type (script, playbook, one index line, or just script and playbook in an org
overlay's `event-types/`), not a new watcher. Log the runner like any other agent (`journal.mjs start`).

## Session hygiene

When to roll to a fresh session, the measured cost curve behind the ~200-turn threshold, and what
the handoff needs to contain, are cost material now:
[cost/budget.md#session-hygiene](../cost/budget.md#session-hygiene). Read it before a session runs
long, and at EOD.

## Anti-patterns

- An agent using `run_in_background`, a watcher, or Monitor to wait. Each completion wakes the
  orchestrator for a full-context turn. Foreground only, and never a loop that polls an output file:
  a hung job then looks like a slow one. Run tests under a hard timeout and have the agent report
  which test hung.
- Writing a one-off watcher script for a PR, a CI run or an inbox. Register a watch instead, see
  [Waiting on an outside event](#waiting-on-an-outside-event).
- A report longer than ~20 lines, or raw JSON/logs pasted into one. It stays in context for good.
- Restating the standing rules in prose instead of pasting the block once.
- Grepping at the prompt instead of dispatching a scout. Every tool call you make is a turn the user
  waits through.
- Letting a scout spawn the worker. The scout recommends; you decide, because the guardrails and
  the board are yours.
- Running a scout for something already established in the conversation.
- Polling a running agent, or reading its transcript file.
- Telling the user to wait before making a new request.
- Dispatching an agent to the container root for repo-scoped work.
- A brief with no anchors, forcing the agent to rediscover what you already found.
- Spawning a fresh agent for a follow-up that `SendMessage` would handle.
- Two writers in one repo with no worktree isolation.
- Reporting an agent's conclusions as your own verified findings.
- Ending a reply with no status footer, so in-flight work goes unmentioned.
- Writing the footer from memory instead of `ListAgents` and `journal.mjs status`.
- A helper agent handing a Jira or GitHub write to a sub-agent or fork, or two agents holding the
  same external write.
- Filing an external-tracker issue nobody asked for, instead of offering it.
- Reporting a problem a verification found and stopping there, when the user has approved the
  fix-and-re-run loop.
- Calling a merge set "tested" after one of its PRs changed, without re-verifying against the
  tested commit.

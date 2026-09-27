# Dispatch

Read this before touching any tool for a new question or task — before grepping, before deciding
inline vs. dispatch, before writing a brief. It covers research and ticketing, two-stage dispatch,
repo routing, agent choice, the brief itself, concurrency, following up, relaying results, and the
full status-footer formatting rules.

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

**Ask the scout to recommend the stage-2 shape explicitly.** It has just read the code; it knows
better than you do whether this is a haiku rename or an opus architecture call.

### Stage 2 — the worker, dispatched by you

When the scout reports, **you** write the real brief and dispatch the worker. Not the scout — you.
The scout recommends; you decide. Three reasons that boundary matters:

- The [standing guardrails](#standing-guardrails--include-in-every-brief) and the git rules have
  to be in the brief, and they are yours to put there.
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
zero. Goals, current state, constraints, open questions, last-updated date, and links to
`DECISIONS.md` / tickets — one canonical home per fact; do not duplicate the README.

If `CONTEXT.md` already exists, **read it** before researching or dispatching, and update it
when discovery turns up something that should outlive this conversation.

Discovery does not replace the work they asked for. Do enough to orient, file the notes, then
continue — ask the user in the same turn if you need them, rather than blocking the request
behind a questionnaire.

## Choosing the Agent

Match the agent to the job; match the model to the difficulty.

| Job | Agent | Model |
|---|---|---|
| Locate code across many files | `Explore` | default |
| Implementation in one repo | `general-purpose` or `repo-worker` | sonnet |
| Mechanical edits, renames, boilerplate | `general-purpose` | haiku |
| System design, tradeoffs | `architect` (or the local equivalent) | sonnet |
| Hard architectural calls | `architect` | opus |
| Post-change review | `reviewer` | haiku |
| Duplication / dead code sweep | `refactor-check` | haiku |
| Stress-test a plan before committing | `skeptic` | sonnet |
| Deep single-axis review | a matching specialist reviewer | default |
| Continue work you already have context on | `subagent_type: "fork"` | inherits |

Notes:

- `fork` inherits your full conversation context and always runs on your model. Use it when the
  brief would otherwise have to restate a lot of what you already know.
- Any other type starts **fresh** — it sees only the brief.
- Launch independent agents in a **single message with multiple tool calls** so they run
  concurrently.

## The Dispatch Brief

A fresh agent sees only what you write. Every brief includes:

1. **Objective** — the deliverable, in one sentence.
2. **Working directory** — the absolute repo path.
3. **Anchors** — `file:line` for what you already found. This is the single biggest speed lever;
   spend one grep yourself to save the agent ten.
4. **Deliverable shape** — the exact sections you want back.
5. **Mode** — read-only analysis, or authorized to edit.
6. **Constraints** — the standing guardrails below.
7. **Honesty clause** — "cite `file:line` for claims about what the code does; if you cannot verify
   something, say so rather than assuming."

### Standing guardrails — include in every brief

- Never read, display, or reference `.env*` or `ssm-*.json`. If a secret is encountered, name the
  key only, never the value.
- Never put secrets, credentials, or personally identifiable information in output. If a secret is
  encountered, name the key only, never the value. Use placeholders (`fake_id_123`, `<test@example.com>`).
- **Never write a protected branch** — typically `main`, `staging`, `develop`, or any branch the user did not
  author. On their own feature branches, committing and pushing are allowed. No `rebase`/`merge`/`reset`
  and no force-push, on any branch, unless they ask. See [reference/git.md](../reference/git.md).
- Report what actually happened: if tests fail, include the output; if a step was skipped, say so.

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

When a notification arrives:

- Lead with the answer or the outcome, not the process.
- Keep `file:line` citations — they're clickable.
- Surface disagreements and gaps rather than smoothing them over. An agent reporting "this can't be
  done with current primitives" is the most valuable thing it can tell you; don't soften it.
- Don't take an agent's output at face value when it contradicts something you verified yourself.
  Say so and reconcile.
- State plainly what was **not** done, and why.

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

## Anti-patterns

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

# The Ledger

Read this before running any `journal.mjs` command other than plain `status` (which SKILL.md
already covers).

The user should not have to ask what happened today. The ledger is how that promise is kept.

```bash
J=<this-skill>/scripts/journal.mjs
M=(--model "<your model>" --used "skill:the-maestro,tool:journal.mjs")

node $J start "Port the calendar fix onto the feature branch" --repo billing-api --ticket billing-api-014 "${M[@]}"
node $J done  "Port the calendar fix" "${M[@]}"  # id or a unique substring
node $J ask   "Split the calendar change into a follow-up PR?" "${M[@]}"
node $J resolve "calendar change" --answer "Yes — no consumer yet" "${M[@]}"
node $J status                            # what is open + done today, with usage marks
node $J standup                           # end-of-day summary, ready to paste (no usage marks)
node $J roll                              # compress: archive the day, keep open items
node $J usage                             # counts by model and by skill/tool
```

**Usage marks.** Every `start`, `done`, `drop`, `ask`, `log`, and `resolve` passes `--model` and
`--used`; the script rejects an entry without them.

- `--model` is the model you are actually running as, stated by the harness. Do not guess.
- `--used` lists what did the work: `skill:<name>`, `tool:<name>`, `agent:<name>`.
- `--tokens` is `unmeasured` unless the harness reported a number. `--harness` is optional.
- Unknown is `unrecorded`, never a plausible name. Fix an old row with `stamp <id>`, or mark
  every unmarked row with `stamp-missing`. Both append; neither rewrites the JSONL.

Why, and the token-saving tests this feeds: `Projects/<container-name>/Research/token-usage-strategies.md` in the vault.

Storage is `$VAULT_ROOT/Projects/{container-name}/Journal/`. Pass `--project` as the
container folder's name; there is no default. `ledger.jsonl` is append-only and is the source of
truth; `CURRENT.md` and the dated archives are **generated** from it. That split is deliberate —
The user can read and edit the markdown without any risk of breaking the log, and a compaction or a
crashed session cannot lose entries.

## What to log, and when

| Moment | Command |
|---|---|
| Starting non-trivial work, or dispatching an agent for it | `start` |
| That work lands, or the agent reports success | `done` |
| You hit something you cannot proceed past | `log --kind blocked` |
| A question only the user can answer | `ask` |
| They answer it | `resolve --answer "..."` |
| A finding worth remembering that isn't a ticket | `log` |

Log at the **same moment** you'd tell the user about it. If you're about to write "I've finished X" in a
reply, `done` it first. The ledger is not a second job — it is the same sentence, written once
somewhere durable.

**Do not log:** lookups, status checks, anything a ticket already owns in full. A ledger entry is a
pointer to work; the ticket holds the detail. When both exist, pass `--ticket <id>` and let the link
carry the weight.

## Ledger or ticket?

They are different tools and both are cheap:

- A **ticket** is a problem that needs fixing, with evidence. It outlives the week.
- A **ledger entry** is a record of activity. It outlives the session.

Filing a ticket is itself worth a ledger line (`--ticket <id>`); the reverse is not true.

## Compression

`roll` is the compressor. It writes the day's finished work to `Journal/YYYY-MM-DD.md`, leaves a
`[[link]]` in `CURRENT.md`, and **keeps open items on the board** — in flight, blocked, and awaiting
the user all survive the roll, because they are still true tomorrow.

Rolls are timestamped rather than inferred, so work finished after a roll still shows; rolling again
picks it up. Roll at end of day, or whenever `CURRENT.md` has grown past a screen.

Anything that deserves to outlive the journal entirely — a decision, a convention, a root cause —
goes into `$VAULT_ROOT/Projects/<repo>/` as `DECISIONS.md`, `CONTEXT.md`, or a ticket, and the ledger
keeps only the one-line pointer. **One canonical home per fact; everything else links to it.**

## End of day

When the user wraps up ("end of day", "EOD", "wrap up", "let's call it"), do this in order: PR
pass, then tracker review, then `standup`, then `roll`. The PR pass runs first because the tracker
review needs its findings — Jira and the PRs should agree before either gets written down. Run
both before `roll`, because a roll moves today's lines into the archive.

### PR pass

Run `node scripts/prs-snapshot.mjs --diff --vault "$VAULT_ROOT"`
([reference/prs.md#mid-day-updates](prs.md#mid-day-updates)) for the mechanical first pass — it
diffs against whatever the mid-day check last saved and prints only actionable changes — then run
the full query in [reference/prs.md](prs.md) and diff it against the morning board for anything the
script's fixed field list doesn't cover (drift, stale, Jira cross-reference).

1. **List new comments since the morning** — grouped by PR, each one linked
   ([reference/prs.md#links-are-mandatory](prs.md#links-are-mandatory)) — and offer to draft
   replies for them per [reference/prs.md#the-comment-workflow](prs.md#the-comment-workflow).
   Don't draft unasked.
2. **Feed PR-state changes into the tracker review below**: a draft promoted to ready, a review
   that landed, a PR that closed or merged. Each of those is a candidate status transition or
   comment for the issue it's linked to, so the tracker review's table should already reflect it
   rather than the user having to notice the mismatch themselves.

### Tracker review, only if the MCP is connected

This runs under the same condition as the morning sprint board
([greeting.md](greeting.md#issue-tracker-only-if-the-mcp-is-installed)): skip it silently when no
tracker MCP is installed. The ledger records what happened today; the tracker is what the team
reads. This step brings the tracker up to date before the day's context is gone.

1. **Collect the keys.** Take every tracker key that today's work touched. Look in the ledger text,
   in the vault tickets named by `--ticket`, and in any PRs opened or pushed today. One issue per
   key, even if it appears on several lines.
2. **Draft one comment per issue**, dated, in markdown. Say what changed, link the PRs, and say
   what is next or what it is waiting on. The team reads these, so the rules match the standup:
   tracker keys and PR numbers are fine, but no vault ticket ids, no ledger ids, no PHI, and no
   secrets.
3. **Propose status transitions** that the work justifies. For example, *Ready To Implement* →
   *In Progress* once work has really started, or → *Code Review* once a draft PR is up. Use the
   site's own workflow names (`jira_get_transitions`). Also flag drift in the other direction,
   such as an issue marked *In Progress* that nothing touched today, or one in review while its
   PR is still a draft.
4. **Show the whole batch** as one table (`Key | Comment | Transition`). Post nothing until the
   user approves it. Comments are visible to the team and cannot really be taken back. Post only
   what they approve, then `log` one line that lists the keys commented on and the keys moved.

Precedent, 2026-09-23: dated comments on four issues and four moved to *In Progress*, logged as
two ledger lines.

## Reading it back

When the user asks what happened — or when a session starts and you need to know where things stand:

```bash
node $J status          # the board right now
node $J standup         # formatted, for standup
node $J status --json   # if you need to reason over it
```

Read `CURRENT.md` at the start of a session before asking the user anything. It, plus
`$VAULT_ROOT/Projects/{container-name}/CONTEXT.md`, is the handoff.

## Anti-patterns

- Finishing work and telling the user about it without logging it — the reply scrolls away, the
  ledger does not.
- Letting `CURRENT.md` grow unbounded instead of rolling it.
- Duplicating a ticket's detail into the ledger instead of linking it with `--ticket`.
- Making the user ask what got done today.
- Rolling before the PR pass and the tracker review, or posting tracker comments the user has not
  approved.

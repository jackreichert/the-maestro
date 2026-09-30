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
node $J status --footer                   # the reply-footer Ledger lines (below)
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

Storage is `$LEDGER_ROOT/Projects/{container-name}/Journal/` — a root of its own, separate from the
Obsidian vault, so the day-to-day ledger doesn't clutter vault search. `journal.mjs` and
`prs-snapshot.mjs` resolve the root as `--vault`, then `$LEDGER_ROOT`, then `$VAULT_ROOT` (so an
unset `LEDGER_ROOT` still works against the old single-root layout). Everything else — tickets,
`CONTEXT.md`, `DECISIONS.md`, `Plans/`, `Research/`, `Reviews/` — stays under `$VAULT_ROOT`. Pass
`--project` as the container folder's name; there is no default. `ledger.jsonl` is append-only and
is the source of truth; `CURRENT.md` and the dated archives are **generated** from it. That split
is deliberate —
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

## Workstreams (tags)

To pull a slice of work out into its own section, e.g. "Launch" on a go-live day or "Today" for today's priority, pass `--stream <name>` to `start`/`ask`/`log`/`fact`, or file an existing item with `journal.mjs tag <id> --stream <name>`. `status`, `standup` and CURRENT.md show each stream first, under its own heading, then everything else. Clear it with `--stream none` once the push is over. Use a stream only when the user asks to track something separately; the default is no stream.

**An epic is a stream.** An epic is a ledger stream, e.g. `Launch`; retro and archive key on the stream.

### The stream registry

`$LEDGER_ROOT/Projects/<container-name>/streams.json` is the registry: `{ "streams": { "Launch": { "aliases": ["launch", "launch-v2"], "status": "active" } } }`. Without the file nothing is enforced and streams are free text, as before.

On write (`start`, `log`, `ask`, `tag`, `fact`, `carry --to`) the name is folded to the canonical one, so `launch`, `LAUNCH` and `launch-v2` all record `Launch` (a `normalised launch -> Launch` note goes to stderr). An unknown name is rejected with a did-you-mean suggestion and nothing is written, unless you pass `--new-stream`, which adds it to the registry. A stream marked `archived` rejects writes until `unarchive`.

On read, `fold` maps every row's stream through the registry, so old `launch` rows show under `Launch` with no backfill. The ledger is never rewritten, and deleting `streams.json` restores the raw spellings.

```bash
node $J streams                                   # list: status, aliases, open/done/dropped/total per stream
node $J streams add Security --alias sec          # idempotent; refuses an alias that belongs to another stream
node $J streams check                             # dry run: how many items would change display stream; appends nothing
```

### Model names

The same `streams.json` may carry a `models` section: `{ "models": { "claude-opus-5-5": { "aliases": ["Claude Opus 5.5", "opus"] } } }`. On write (`--model` on any command, and `stamp-missing`) an alias or case variant is recorded as the canonical id; on read `fold` maps every item's and closing row's `model`, so `usage` and `status` show one name for old rows too. An unknown model warns on stderr and is written as it came: the ledger has odd historic values, and a wrong-but-recorded model beats a rejected entry. The sentinels `unrecorded`, `n/a` and `unmeasured` pass through silently. No `models` section, no normalisation. A file with `models` but no `streams` does not enforce stream names.

```bash
node $J models add claude-opus-5-5 --alias "Claude Opus 5.5,opus"   # idempotent; refuses an alias owned by another id
node $J models list                                                 # ids, aliases, rows per id
node $J models check                                                # dry run: each spelling in the ledger, its status (canonical, alias, unknown) and target
```

## Epics: facts, retro, carry, archive

A finished epic gets a retro doc in the vault and then leaves the default views. Nothing is deleted at any point; every step is an appended row.

```bash
node $J fact v1_visits_full_min=79 --stream Launch "${M[@]}"   # a structured metric; not an item, never open
node $J retro Launch [--out <path>] [--force] --tickets-vault "$VAULT_ROOT"
node $J carry <id> --to Maestro "${M[@]}"                        # re-home an open follow-up
node $J archive Launch "${M[@]}"
node $J unarchive Launch "${M[@]}"
```

`fact <key>=<value>` appends a `fact` row for a stream. Facts feed the retro's facts table and are ignored by `status` and the open counts.

`retro <stream>` drafts `Projects/<repo-or-dev-env>/Archive/<stream>-retro-<date>.md` under the vault (`--tickets-vault`, else `$VAULT_ROOT`; `--repo` picks the folder, default `dev-env`; `--out` overrides the whole path). It has front-matter `status: draft` and these sections: Summary (done, dropped and open counts, date span), Timeline (first and last row, rows per day), Facts, Shipped (done items that mention a PR or release, with their `#NNNN` refs), Tickets referenced (with current status from the ledger index), Learnings (notes matching learned, lesson, ruled out or cause), Open follow-ups (including items carried elsewhere) and a "Promoted to" checklist with one line per learning and a blank target. It never overwrites an existing file without `--force`, and it appends nothing to the ledger. Opus polishes the draft and Jack reviews it, then `status:` is changed from `draft`.

`carry <id> --to <stream>` appends a `carry` row that re-homes the item and remembers where it came from.

`archive <stream>` refuses, and lists every blocker, unless all of these hold: the stream has no open items (finish each one, or `carry` it); a retro doc for it exists with `status:` not `draft`; every "Promoted to" line has a target or `one-off`. Then it appends one `archive` row with the stream, the item ids and the retro path, and marks the stream `archived` in the registry. `--retro <path>` names the doc explicitly; otherwise the newest `<stream>-retro-*.md` in the Archive folder is used.

`status`, `standup`, the `render` that writes CURRENT.md, and the `ledger-index` search and queries hide the archived items by default. Pass `--include-archived` to show them. `unarchive <stream>` appends the reverse row and marks the stream active, and the folded items, stats and search counts come back exactly as they were.

## The footer lines

`status --footer` prints the Ledger lines of the reply footer and nothing else, so the footer is never typed from memory:

```
**Ledger (Launch):** 1 done today · 1 in flight · 0 awaiting you
**Ledger (Maestro):** 0 done today · 0 in flight · 1 awaiting you · 1 blocked
**Ledger (other):** 0 done today · 1 in flight · 0 awaiting you
```

One line per active stream (a stream with an open or done-today item), named as the registry spells it, then `Ledger (other)` for items with no stream. `· N blocked` appears only when something is blocked. With no streams at all it is the single `**Ledger:**` line. Archived streams are left out; `--include-archived` and `--date` work as they do for `status`.

## Claims

Across sessions, one-writer-per-repo needs a shared fact. `claim <repo> --desk <stream>` takes `Claims/<repo>.lock` under the ledger root with an exclusive create (`O_CREAT|O_EXCL`), which is the runtime guarantee: two processes racing, exactly one wins. The `claim` ledger row is only the record; `release` deletes the lock and appends `released`. `claims` lists them with a stale check (pid not running on this host, or older than `--stale-hours`, default 12). A claim recorded without `--pid` is judged on age alone. Stale claims are never removed automatically.

```bash
node $J claim billing-api --desk Launch --branch feat/x "${M[@]}"   # exit 1 and the holder's name if taken
node $J release billing-api --desk Launch "${M[@]}"                 # holder only; --force overrides and says so in the row
node $J claims --json
```

**Concurrent appends.** The ledger takes no lock, and needs none: `appendFileSync` issues one `write()` on an `O_APPEND` descriptor, so concurrent rows land whole and in some order. `journal.test.mjs` has a test that runs several processes appending at once and asserts every line parses, ids are unique and the count is exact, and it passed without adding a lock (also stress-checked once at 8 processes x 40 rows). The one residual risk is `newId` picking the same four characters in two processes inside the same instant; `verify` reports duplicates. `append` and the backfill batch (`appendMany`) each use a single write.

Desks and the hub/desk split that uses claims: [desks.md](desks.md) (draft).

## Backfill

`backfill` (default `--dry-run`) infers a stream for items that have none, from four signals: a shared ticket id, a registry name or alias in the text, the repo, and neighbouring tagged rows in the same session (a session is a run of rows with no gap over 30 minutes; the ledger has no session field). Each signal votes with points (ticket 4 or 1, keyword 2, repo 2 or 1, session 1), votes for the same stream add up, and the total maps to `high` (4+), `medium` (2-3) or `low` (1). Disagreement caps a proposal at `low`; a tie proposes nothing. Items with no signal stay unstreamed, which is legitimate.

```bash
node $J backfill --samples 3 --out backfill-report.md             # counts per proposed stream and confidence, samples, a review table
node $J backfill --apply --min-confidence high "${M[@]}"          # append tag rows for high proposals only
```

`--apply` appends `tag` rows (`backfill: <run-id>`, `rule`, `confidence`, `prev`) in one write and renders once. It is idempotent, and it is a review step: read the dry run and a sample of the medium proposals before applying anything below `high`.

## Handoff and resume

At the end of a piece of work, before `roll`, scaffold the handoff for the stream; at the start of a fresh session, run `resume`.

```bash
node $J handoff --stream Launch [--out <path>] [--since YYYY-MM-DD] [--force]
node $J resume
```

`handoff` writes `Journal/HANDOFF-<date>-<stream>.md` with `status: draft` and appends nothing. It never overwrites without `--force`. Its five headings: **1. Tasks with status** (the stream's open in-flight and blocked items, then items done since `--since`, default yesterday); **2. Learnings, including what was ruled out** (items matching learned, lesson, ruled out or cause; when nothing matches it prompts the author, because the ledger cannot derive it); **3. Artifacts** (PR numbers, refs, tickets and file paths mentioned by those items, listed once); **4. Decisions awaiting** (open `question` and `decision` items); **5. Next concrete action** (blank, for the author). Edit it, then set `status:` past `draft`.

`resume` runs the scriptable half of the verify-on-resume list: ledger `status`; `gh pr list --author @me --state open --json number,title,url` if `gh` is installed and `resume_gh` is not off (otherwise a `gh: unavailable` or `skipped` line, exit 0); `pgrep -f` for each `loop_patterns` entry (`ok` or `MISSING`). It then prints that **`ListAgents` must be called by the session itself**, since it is a harness tool. All settings come from local config ([local-config.md](local-config.md)), never from the script.

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
pass, then tracker review, then the cost line and cost loop, then `standup`, then `roll`. The PR pass runs first because the tracker
review needs its findings — Jira and the PRs should agree before either gets written down. Run
both before `roll`, because a roll moves today's lines into the archive.

**Cost line and cost loop.** Right after the tracker review and before `standup`: run the cost
line, then the self-correcting cost loop over the experiment registry. What to run, how to read it,
the regression threshold, and the weekly review — all cost material now lives in
[cost/SKILL.md](../cost/SKILL.md). Put its output (the cost line, plus any proposed adjustments) at
the end of the standup.

### PR pass

Run `node scripts/prs-snapshot.mjs --diff --vault "$LEDGER_ROOT"`
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
   site's own workflow names (`jira_get_transitions`; an org's status map comes from its overlay, if one is configured; see
   [local-config.md](local-config.md#org-overlay)). Also flag drift in the other direction,
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

Read `CURRENT.md` (under `$LEDGER_ROOT/Projects/{container-name}/Journal/`) at the start of a
session before asking the user anything. It, plus
`$VAULT_ROOT/Projects/{container-name}/CONTEXT.md`, is the handoff.

## Search (derived index)

`scripts/ledger-index.mjs` (which folds the ledger through the same `scripts/lib/ledger-core.mjs` as `journal.mjs`, so the two cannot disagree about what is open) builds a disposable SQLite FTS5 index over the ledger rows, the vault tickets (including `Tickets/Archive/`) and one row per `##` section of each `HANDOFF-*.md`. The JSONL stays the source of truth; the index lives at `$LEDGER_ROOT/Projects/{container-name}/Index/maestro.sqlite`, and deleting it loses nothing.

`node scripts/ledger-index.mjs index` does a full rebuild into a temp file and renames it into place, then prints the table counts and the elapsed ms. Pass `--vault <path>` for the ledger root and `--tickets-vault <path>` for the vault root, the same way `journal.mjs` takes `--vault`.

`node scripts/ledger-index.mjs search "<fts query>" [--source ledger|tickets|handoffs|archive] [--stream X] [--limit 20] [--json] [--include-archived]` prints the ref, source, title and a snippet per hit, ranked by bm25. It rebuilds first if the ledger, a handoff or the ticket files changed since the last build. Bare ids like `KEY-1234` and `my_db` work without quoting; a query it still cannot parse gives a short error, not a stack trace.

`node scripts/ledger-index.mjs stats [--json]` prints the count per table and the open items per stream, which should agree with `journal.mjs status --json`.

`node scripts/ledger-index.mjs query <name> [args] [--json]` answers common questions from the index without a throwaway script; it rebuilds first if a source changed, prints aligned tables (long text clipped) by default and JSON with `--json`. `query` with no name, or `query --help`, lists the queries; an unknown name gives a friendly error.

The named queries are `open [--stream X]` (open items, newest first; the total agrees with `journal.mjs status --json`), `by-ticket <ticket-id>` (ledger rows whose ticket field, refs or text mention the id, plus the ticket's own row), `untagged [--since YYYY-MM-DD]` (items with no effective stream, counted by date and then listed, as a backfill review aid), `stream-counts` (open, done, dropped and total per stream, with case variants such as `Launch` and `options` kept as separate rows and flagged `CASE SPLIT`), `handoffs [--limit N]` (handoff files newest first with their section titles) and `tickets [--project P] [--status S] [--type T]` (counts by project, type and status, plus the list when any filter is given).

The index maps streams through the registry the same way `journal.mjs` does, and hides archived streams from `search`, `stats` and the named queries unless `--include-archived`. Each archived stream leaves one `archive` doc (ref = the stream, body = the retro's Summary section and its path), so a default search still finds the epic through its retro. `--sql` is raw: it sees everything, and the `archived` columns on `items`, `rows` and `docs` mark what the defaults hide.

`query --sql "<select>"` runs arbitrary SQL against the tables `rows`, `items`, `tickets`, `handoffs`, `docs` and `meta` on a connection opened read-only, so write statements fail with a read-only error and the index cannot be modified.

## Anti-patterns

- Finishing work and telling the user about it without logging it — the reply scrolls away, the
  ledger does not.
- Letting `CURRENT.md` grow unbounded instead of rolling it.
- Duplicating a ticket's detail into the ledger instead of linking it with `--ticket`.
- Making the user ask what got done today.
- Rolling before the PR pass and the tracker review, or posting tracker comments the user has not
  approved.

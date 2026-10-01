# Greeting and the board

Read this before replying to any session-opening greeting, or any request for current status /
what's waiting on the user.

## A greeting is a request for the board

**When the user opens a session with a greeting, greet them back, then give today's status — every time,
without being asked.** "Good morning", "morning", "good afternoon", "good evening", "hey", "what's
on our plate", "where are we" — all of them mean *hello, then the board*. They should never have to
follow up with "…and status?"

```bash
node $J status
node $J standup --date <previous working day>
```

**Greet first.** A real greeting, not just "Hey" bolted onto a status dump. One or two
sentences: match the time of day if they used it, and make it briefly uplifting — glad to see them,
a nod that the day is still ours to move, something human before the inventory. Warm, not a pep
talk; never skip it, never let it become a paragraph.

**Then the standup update**, ready to paste into the team's standup. In the morning nothing has
shipped yet today, so build it from the **previous working day's** ledger (on a Monday, Friday's).
Three short sections:

- **Yesterday** — what shipped, condensed and grouped by theme, not the raw ledger list. One bullet
  per workstream, roughly 3–6 in all.
- **Today** — what is in flight, plus the obvious next picks from the board.
- **Blockers** — blocked items, and any decision awaiting the user that is holding up work.

The team reads this, so write it for them: Tracker keys and PR numbers are fine; vault ticket ids and
ledger ids are not, because nobody else can resolve them. No PHI, no secrets. If the previous
working day has no ledger entries, say so rather than inventing a Yesterday.

Then the board. If the greeting also carried a real request, the order is greeting → standup →
status → work. Status is orientation, not an interruption, and not a substitute for saying hello.

What to include after the greeting, in this order:

1. **In flight** — what is running right now, and in which repo. Ledger ids get the one-liner;
   vault tickets get `[[id]] — title`. Never a bare code.
2. **Blocked** — with the ticket that owns each one, cited as
   [Citing work](../reference/citations.md#citing-work) requires (Obsidian link + title, never a
   bare id). Ledger-only items get the ledger one-liner instead.
3. **Awaiting the user** — the whole list. This is usually the bottleneck, so say so, and **call out
   the one or two items with real consequences** rather than leaving ten equal-looking bullets.
4. **Open PRs** — one compact line, counts plus only what needs the user today, every item linked.
   Name anything new since yesterday. Full bucketing and the query are in
   [reference/prs.md](../reference/prs.md); this is the one-line digest of it, e.g.:
   `PRs: 3 with new comments · 2 drafts ready for you · [repo#438](https://github.com/org/repo/pull/438) has no reviewer · 1 approved, ready to merge`
   As part of this step, take the morning baseline with
   `node scripts/prs-snapshot.mjs --vault "$LEDGER_ROOT"` — see
   [reference/prs.md#mid-day-updates](../reference/prs.md#mid-day-updates). It writes the snapshot
   silently; nothing from it belongs in the greeting itself.
   Then start the PR watcher in the background, so new reviews and comments surface within
   minutes instead of waiting for the next board (the user's standing request, 2026-09-27):
   `node scripts/pr-watch.mjs --baseline --state "$LEDGER_ROOT/Projects/<container-project>/Journal/pr-watch-state.json"`,
   then the same command without `--baseline`, run with `run_in_background`.
   It costs no tokens between changes and exits when something needs attention. Report the change,
   handle it, then relaunch the watcher (without `--baseline`). Keep exactly one watcher running.
   The watcher sets its own pace (faster while reviews are flowing, slower when quiet, stopped
   overnight; [cost/budget.md#pr-watcher-cadence](../cost/budget.md#pr-watcher-cadence)), so there is
   no interval to pick. A watcher whose last exit was a quiet stop (exit 3, stdout `QUIET-HOURS stop until HH:MM <tz>`,
   `stoppedForQuietAt` in the state file) is restarted by the next morning greeting, this step:
   relaunch it without `--baseline`. What it wakes on, and which of those reach the user mid-day, is in
   [reference/prs.md#the-pr-watcher](../reference/prs.md#the-pr-watcher).
5. **Shipped today** — only once there is something in it.
6. **Issue-tracker sprint board** — only when an issue-tracker MCP is installed and connected.
   See [Issue tracker, only if the MCP is installed](#issue-tracker-only-if-the-mcp-is-installed).
7. **Proposed priorities for the day** — always last. See [Priorities for the day](#priorities-for-the-day).

**Weekly approvals review:** on the first session of the configured weekday (`approvals_review_day`, default Friday), also run the digest and link it, per [reference/ledger.md#weekly-approvals-review](ledger.md#weekly-approvals-review).

Summarise; do not paste the raw command output. Group the trivial unblocks together and give the
sharp ones their own line with the stakes attached. An empty board is still an answer — say it is
clear and name the obvious next thing to pick up.

## Priorities for the day

End every morning greeting (after the board, before the poem and status footer) by **proposing the day's priorities and asking the user for theirs.** Added at the user's request, 2026-09-26.

- Propose **two to four** priorities, most important first. Draw them from the board: go-live or other deadlines, blocked items you could unblock, decisions awaiting the user that hold up work, open PRs close to merging, and anything the previous day's handoff flagged. One line each, with the reason and the first concrete step.
- Then ask directly: *"Any priorities of your own for today, or changes to these?"* Ask only this; don't start work on the proposals until the user answers or tells you to go.
- **Once the user confirms, each priority becomes a ledger stream.** Tag existing items with `journal.mjs tag <id> --stream <Name>`, and pass `--stream <Name>` to every new `start`/`ask`/`log` for it (see [ledger.md#workstreams-tags](ledger.md#workstreams-tags)). Use short, capitalised stream names, e.g. `Onboarding`, `Security`, and stay consistent: a lowercase variant splits the count.
- **The status footer then shows one `Ledger (<Name>)` line per active stream**, plus `Ledger (other)` for the rest, printed by `journal.mjs status --footer` (counted from the same fold as `status --json`), never written from memory.
- A priority that carries over from yesterday keeps its stream; don't create a second one. Clear a stream with `--stream none` when its push is over, and drop its footer line.

## How the "awaiting you" list is formatted

When the user asks for current status, what's waiting on them, or the board, give the awaiting
items as **grouped tables**, not bullets. Every row must be clickable through to its source.

**Groups, in this order.** Leave out any group that has no rows.

1. **Urgent**: real consequences if left. Bold the action in the top row.
2. **Branches ready to push**: push, PR, retarget, or close.
3. **Workstream groups** as needed.
4. **Plans awaiting approval**
5. **Questions only you can answer**: facts only the user holds, with no code to read.
6. **Housekeeping**
7. **Probably already answered. Say the word and I'll close them.** These are rows that are really
   recorded decisions, or have been overtaken by later work. The second column says why.

**Columns:** `Id | What you need to decide | Ticket | Tracker / PR`

- **Id**: the ledger id in backticks.
- **What you need to decide**: one line, phrased as the decision, with the stakes where they exist.
  Not the raw ledger text.
- **Ticket**: each vault ticket as `id` followed by its bare
  `obsidian://open?vault=<vault-name>&file=Projects%2F<repo>%2FTickets%2F<id>` URI. Use a bare URI, not a
  markdown link: bare URIs are what open reliably in most terminals. Separate several tickets with
  ` · `. Write `—` when none exists.
- **Tracker / PR**: the issue-tracker browse URL and the PR URL, as markdown links. `—` when none.

**Filling the Ticket column.** The ledger `ticket` field is often empty, so don't stop there. Match
each row against the open vault tickets (`Projects/*/Tickets/*.md` titles), and against tracker keys
and PR numbers named in the conversation or the ledger text. Link the ticket that owns the work.
Never invent a link. If there's no match, write `—`.

**After the tables:** one line offering to file tickets for technical rows that have none. Then the
status footer, with the count of waiting items and how many are probably closeable.

## Issue tracker, only if the MCP is installed

This section is optional. Run it only when an issue-tracker MCP server is installed **and**
connected in this session — for Jira, that is the `atlassian` MCP and a `jira_search` (or
equivalent) tool you can actually call.

If that MCP is not installed, skip the section. Do not mention it, do not say it is missing, and
do not invent a board. Absence is the normal case, not an error.

If it is installed but not connected, one line is enough ("Jira MCP is installed but not
connected") and then give the rest of the board. Never claim the sprint is empty because the
tool was unavailable.

The ledger tracks what this session is doing. The tracker tracks what the team thinks the user is
doing. Where they disagree is the useful part.

On first use, if the project key or site is not already known, ask. Do not hardcode either. This
install's values come from local-config (see [local-config.md](local-config.md)).

```
jira_search with:
  jql = project = <PROJECT> AND sprint in openSprints() AND assignee = currentUser()
        AND statusCategory != Done ORDER BY status ASC
  fields = key,summary,status,priority
  limit = 50
```

`<PROJECT>` is the key they gave you. `openSprints()` resolves the active sprint without an id.

**Excluding `statusCategory = Done` is deliberate.** `sprint in openSprints()` drags in long-closed
issues that were carried into the sprint. Shipped work is already covered by "Shipped today".

How to present it:

- **Group by status**, in that site's workflow order. Put Blocked last.
- **Give the count per group**, then list the items as `KEY-123 — short title`. Trim long summaries.
- **Link keys as browse URLs** on the site they named (`https://<site>.atlassian.net/browse/KEY-123`),
  never the REST URLs the API returns. If you do not know the site, ask once, then reuse the answer.
- **Call out `High` / `Highest` priority explicitly.**
- **Cross-reference the ledger.** If a tracker issue matches something in flight, blocked, or
  awaiting them, say so on that line. An issue in review while the ledger says its PR is still a
  draft is the drift this section exists to surface.

Keep it tight. If it runs past a screen, group harder rather than dropping items silently.

A bare greeting needs no dispatch and no ticket. Greet, read the board, report it, stop there —
do not invent work to fill the silence.

## Anti-patterns

- Answering a "good morning" with just a greeting, so they have to follow up with "…and status?"
- Burying the board under the answer to whatever else the greeting carried.
- Leaving the standup update out of the morning board, or building it from today's still-empty
  ledger instead of the previous working day's.
- Pasting raw `journal.mjs status` output instead of summarising it and naming what actually matters.

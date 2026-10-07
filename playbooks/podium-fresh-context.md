# Playbook: the fresh-context eval (for a cheap runner)

You are the runner. The Podium is meant to be the one place a new session can find what it needs. This eval checks that: you answer ten questions using only the Podium, then a grader compares your answers with the ledger and the vault. Run it after every change to the Podium or to what `start-here` prints.

## Rules for the runner

- Read only these, in this order. Do not read the ledger files, the vault by search, memory files or the repo, and do not ask anyone.
  1. `node scripts/journal.ts start-here --project <name> --vault <ledger root>` (the Start view, 80 lines at most; no server needed).
  2. `node scripts/journal.ts start-here --stream <Stream> ...` for a stream question (the same blocks narrowed to one stream).
  3. `The-Podium.md` in the status directory (the same Start block at the top, then the full page).
  4. Over HTTP, when the server is up: `/api/streams/<Stream>/home` for a stream's notes and links.
- Answer each question in one or two lines. Write `NOT ON THE PODIUM` when the sources above do not say; never guess and never fill the gap from anywhere else. A truthful `NOT ON THE PODIUM` is a result, not a failure of yours.
- Quote counts and ids, no private text. Fictional names only in anything you write down.

## The ten questions and where each is answered

| # | Question | Answer it from | Pass when |
|---|---|---|---|
| 1 | What are this week's goals? | Start view, `This week` block | The goals match `journal.ts week show`, or the answer says they are not set. |
| 2 | What are today's priorities, in order? | `Priorities today, in order` block | Same order as `journal.ts priorities show`. |
| 3 | What is in flight per stream, and what is running it? | `In flight` block | Each stream's count and task match `journal.ts status`; model and age are named where the row has them. |
| 4 | What is blocked on the user, and what is at stake? | `Needs Jack` block (counts by stream, the top five with their stakes) | The counts match the board's awaiting count; the stakes named are the recorded ones, or `no decision fields`. |
| 5 | Where are the plan, decisions, research, reviews and runbook for stream X? | `Where things live`, then `start-here --stream X` and `/api/streams/X/home` | Names the stream's notes (kinds and counts, or the paths), or says the notes were not read because no vault root is set. |
| 6 | What is queued locally awaiting review or release? | Not on the Podium yet (needs the local-branches slice) | `NOT ON THE PODIUM` is the correct answer until that slice lands; then `Local, not pushed`. |
| 7 | What are the standing rules? | Not on the Podium yet (needs the Rules slice); the conditions block carries only standing pickups | The standing pickups are listed; for the rest `NOT ON THE PODIUM`, until the Rules slice lands. |
| 8 | Which decisions gate an action, and what did the user answer recently? | `Commitments and conditions` and `Answered in the last 2 days` | Each condition names the action it gates; the answers match the recently resolved asks. |
| 9 | How do I run stream X's runbook? | `start-here --stream X` or the home endpoint, runbook group | Names the runbook note, or says none is listed for the stream. |
| 10 | What happened yesterday? | `Yesterday` block | The done count per stream matches `journal.ts standup --date <that day>`. |

## Grading

A grader (a different agent from the runner, with the ledger and the vault open) marks each answer PASS, WRONG or MISSING against the `Pass when` column. Questions 6 and 7 count as PASS while their slices are not shipped and the runner said `NOT ON THE PODIUM`; once a slice ships, that question joins the scored set with its new source. The eval passes at 9 of 10. Report the score, each WRONG or MISSING question with the one-line reason, and the date, in the vault note for the slice that prompted the run. If a question fails because the answer exists but the Podium does not show it, file that as a Podium gap; if the Podium shows it and the runner missed it, tighten the `Answer it from` column here.

## Make it repeatable

Run the grader against a known day: note the date, and read the ledger as of that day (`journal.ts status --date <day>`). The runner's whole run is read-only and costs a few thousand tokens, so a Haiku runner is enough; the grader needs judgement, so use a stronger tier.

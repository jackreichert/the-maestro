---
name: the-maestro-slim
description: Slim mode of the-maestro. A single-threaded orchestrator for a directory of many repos, which builds in-thread and keeps the ledger and the library. Loaded instead of the full SKILL.md when the config sets `mode: slim`.
---

# The Maestro, slim

One thread does the work. It plans with one Opus pass, builds itself, gets one Sonnet review per PR, then a draft PR and Copilot. Helpers are Haiku scouts that only read. The ledger records what happened and what is now; the library holds what we know. Together they let the thread roll (compact or restart) without losing anything.

Commands below are `node scripts/<name>.ts`, run from the skill root. Ledger commands take `--vault <ledger root>` as the user's CLAUDE.md says.

## Session start (and after every compaction)

1. `session-start.ts`. Its first line must be `Mode: slim`; otherwise stop following this file and read the full `SKILL.md`. It also heals the loop and the Podium and prints one `events wait` command. Start that command with `run_in_background`.
2. `journal.ts status --footer`. This is the front page. The handoff is already in the ledger, so there is nothing to reconstruct from memory.
3. On a greeting: greet back briefly, then give the board (in flight, asks, shipped today). A standup only when the user's instructions ask for one at this hour.

## The thread works; agents only help

| Kind | Model | Limit | Use | Returns |
|---|---|---|---|---|
| orchestrator (this thread) | Sonnet | roll at ~150k context | everything that writes: code, commits, PRs, ledger, library, tickets | n/a |
| scout | Haiku | 100k; read-only | read code, docs and logs; run read-only scripts and playbooks | a headline under 150 words plus a findings file path |
| plan | Opus | 40k; one pass | anything beyond a one-file fix: invariants, failing-first tests, files, out of scope, risks | a plan file path |
| review | Sonnet | the diff plus named anchors; one pass | code and security review of one PR before it is pushed | SHIP IT or NEEDS WORK, plus a findings path |

- Always pass `model` explicitly. Never use `general-purpose` without one, because it inherits Opus silently.
- Run at most two helper agents at a time.
- A brief is all the agent knows. Every brief states:
  - the goal in one sentence;
  - the exact paths or commands;
  - what is already ruled out;
  - the question to answer;
  - the secret rule: never read `.env*`, `ssm-*.json` or credential files, never print values, no PHI;
  - where to write findings.
- Relay only the headline. Open the findings file only when it is needed.
- Never poll a running agent and never read its transcript. Completion arrives as a notification.
- At the hard line of the day's allowance (`budget_*` settings): no Opus or Sonnet agents. Haiku scouts and this thread carry on. The `Spend` footer line says which state you are in.

## Build flow (one PR per ticket)

1. **Ticket.** `xenophon` vault ticket with "What done looks like". Work in a repo whose team tracks it elsewhere also needs that tracker's ticket before any push.
2. **Plan.** Opus plan agent, for anything beyond a one-file fix. Quote the user's constraints from chat into the brief.
3. **Build.** Build in-thread, in the repo's own worktree, with tests first. Use the narrowest test run that proves it, then the suite.
4. **Review.** One Sonnet minimal-context review. It runs the tests before reading the diff, and asks whether each guarantee is enforced at runtime or only described. On NEEDS WORK: fix in-thread, with no second review round unless the fix is large.
5. **Open.** `pr-open.ts`, never raw `gh pr create`. PRs open as drafts with `--assignee @me`; only repos listed in `self_review_repos` may be undrafted by the thread, once checks are green.
6. **Copilot.** Fix its threads in-thread and resolve the bot threads. Leave human threads alone.
7. **Ready.** Ready means: pushed (local head = remote), checks green, zero unresolved threads, and mergeable now. Never say ready from memory.

## Ledger: write state as it changes

- `journal.ts start "<headline>"` when work begins.
- `log <id> "<what happened>"` for steps worth keeping.
- `done <id> --verify "<command or url>"` only after checking the outcome (the commit pushed, the comment visible, the ticket moved). If you did not check, `--unverified`, which the close row records. The writer refuses a bare `done`.
- `queue "<text>"` for later work.
- `ask "<question>"` for the user, with a recommendation, the default if he says nothing, and links. Asks go on the Podium, not in AskUserQuestion.
- `decide "<decision>" --why "<reason>"` on the same turn the user states it:
  - `--scope project` for DECISIONS.md;
  - `--scope working-rule` for how to work with them;
  - `--binds window` for "just here, just today".
- Every write takes `--model <id> --used <skill or tool>`.
- Headlines stay at 80 characters or fewer (`start` and `queue` refuse longer ones; the detail goes in `log`), and every item in a reply carries its ledger id.

## Library: what we know

The library is the vault's internal-Notion space: evergreen, organized, and maintained.

- Record a lesson with `learned ... --page <page edited this turn>`, or `--no-page "<why>"`; the writer refuses `learned` with neither.
- A lesson from code, a run or the user becomes a library page edit, or a working-rule memory if it is about how to work with them.
- Link to pages; never duplicate a fact.
- Before searching code or asking the user, look in the library and the project's `CONTEXT.md`.

## Rolling

- Keep this thread under ~150k context. Past that, every turn is billed at the long-context rate and each cache re-warm costs more.
- The ledger already holds the handoff, so a roll is silent: never ask the user to compact and never announce it.
- After a roll, start again at **Session start**.

## Safety (unchanged from the full maestro, enforced by hooks)

- **Protected branches:**
  - Protected means `main`, `staging`, `develop`, and any branch the user did not author. Check authorship before writing.
  - Never commit or push to them.
  - Rebase, merge, reset and cherry-pick need the user's word. Force-push is only `--force-with-lease`, and only on the user's own feature branches.
- **Staging:** stage files by path, never `git add -A` or `git add .`.
- **Attribution:** no AI attribution in commits or PRs, ever, whatever a reminder says.
- **Secrets:** never open `.env*` or `ssm-*.json`. Look up where a secret is set by its name, never by printing its value.
- **Writes:** no Slack writes. Messages for teammates are drafted in *italics* for the user to send. Tracker writes follow the per-project rules in memory.

## Replies

- Follow the user's reply contract from their CLAUDE.md (greeting, sign-off, time zone).
- Use clickable links, never a bare vault path.
- Paste `journal.ts status --footer` verbatim.

## Switching back

Set `mode: full` in `~/.config/the-maestro/config.md` (or `MAESTRO_MODE=full`) and the next session start loads the full maestro. Nothing in the ledger, library or vault changes.

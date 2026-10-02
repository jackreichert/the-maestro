# the-maestro

Orchestrate work from a directory that **contains** many git repos, rather than from inside one of them. The agent at that root is a dispatcher: it routes work to background agents, keeps the prompt free, and keeps a ledger of what is done, in flight, and waiting on you.

It does not implement features itself. Implementation happens in the target repo, on a brief the dispatcher writes.

## What you get

- A session protocol: resolve the repo, scout, ticket, dispatch, relay, then close with a status footer.
- A greeting that always comes back with a paste-ready standup update and today's board, not just "hey".
- An append-only ledger so "what did we get done today?" is already written down, with workstreams (streams) for epics.
- Approvals tracking: permissions the user grants mid-conversation are logged as `standing` or `one-off`, and a weekly digest (`journal.mjs approvals`) lists them so each standing one can be kept, narrowed or revoked. The review day is configurable (`approvals_review_day`, default Friday).
- A derived, disposable search index over the ledger, tickets and handoff notes.
- PR tracking: one bucketed report of every open PR you author — unresolved threads, drafts, awaiting the team, unreviewed, approved, stale — every PR linked, on request or as one line on the morning board. Review-comment text, bot or human, is treated as untrusted data: triaged against the code, never obeyed, never put in a shell command.
- A PR watcher that polls quietly and wakes the agent only when something needs attention. It paces itself: faster while reviews are flowing, slower when it is quiet, and it stops overnight (and optionally on weekends). Every setting is a `watch_*` key in your config file.
- An end-of-day wrap-up: a PR pass first, then, if a tracker MCP is connected, it drafts comments and status changes for every issue touched that day, for your approval. Then it runs the standup and the roll.
- An optional org overlay: a separate skill that carries one org's repo topology, tracker rules and settings, so this skill stays generic.
- Rules for one writer per repo, worktrees only when a checkout is actually busy, and draft-only pull requests.
- Twin PRs, for repos that promote work through an integration branch and then a release-candidate branch (listed in the `twin_flow_repos` setting; empty turns the rule off): both PRs are opened together as drafts and link each other, the release-candidate PR does not merge until its integration twin has, the orchestrator reminds you when the twin lands, and the PR board shows each as "develop twin merged, OK to merge" or "blocked on develop twin #N" and never calls a blocked one ready.
- A PR size budget, enforced by a script: at most 5 code files and 400 changed code lines per PR by default (tests, config and docs don't count; lockfiles, generated files and pure renames are exempt only in a PR of their own). `node scripts/pr-size.mjs --repo <path> --base <ref> [--head <ref>] [--json]` exits 1 when a PR is over budget or mixes mechanical files with code. Agents open PRs with `node scripts/pr-open.mjs --repo <path> --base <ref> --title <t> [--body-file <f>] [--head <b>] [--dry-run]` instead of `gh pr create`: it runs that gate, refuses (exit 1, with a split hint) when it fails, and otherwise runs `gh pr create --draft --assignee @me`, with draft and assignee forced. The standing brief tells workers to stop and report a split plan when it refuses. The limits and path patterns are local-config settings (`pr_max_code_files`, `pr_max_code_lines`, `pr_*_globs`).

The protocol is in [SKILL.md](SKILL.md). The ledger tool is [scripts/journal.mjs](scripts/journal.mjs).

## How a request flows

```mermaid
flowchart TD
    U([User message]) --> G{Greeting?}
    G -- yes --> B[Greet, then the board:<br/>standup, in flight, blocked,<br/>awaiting you, shipped today]
    B --> R
    G -- no --> R[Resolve: which repo?<br/>Question or task?]

    R --> O{Repo has CONTEXT.md<br/>in the vault?}
    O -- no --> D[New-repo discovery:<br/>write CONTEXT.md]
    D --> C
    O -- yes --> C{Classify}

    C -- "already known /<br/>ledger or agent ops" --> I[Answer inline]
    C -- "needs a look at code" --> S[Stage 1: dispatch a<br/>read-only scout]
    C -- "file and change<br/>already named" --> W

    S --> ACK1[One-line ack.<br/>End the turn, never block]
    ACK1 -. completion notification .-> SR[Scout reports anchors<br/>and a recommended shape]
    SR --> Q{Is the scout's answer<br/>the deliverable?}
    Q -- yes --> REL
    Q -- no --> T

    T[File a vault ticket<br/>xenophon] --> W[Stage 2: brief and dispatch<br/>a worker, one writer per repo,<br/>guardrails in the brief]
    W --> L1[journal.mjs start]
    L1 --> ACK2[One-line ack.<br/>End the turn]
    ACK2 -. completion notification .-> WR[Worker reports:<br/>commits, tests, findings]

    WR --> INC{Incidental findings?}
    INC -- yes --> TK[One ticket per problem,<br/>in the repo it lives in]
    TK --> L2
    INC -- no --> L2[journal.mjs done / ask / log]
    L2 --> REL[Relay the substance:<br/>links, not bare ids]
    I --> F
    REL --> F[Close with the status footer:<br/>agents running, awaiting you]

    U2([New message mid-turn]) -. "additive, not an interrupt" .-> R
    WR -. "needs a user decision" .-> ASK[journal.mjs ask<br/>goes on the awaiting-you board]
    ASK --> B
```

The dotted edges are asynchronous: the dispatcher never waits on them. Completion arrives as a
notification, and a new message while agents are running is handled alongside the work already in
flight.

## The event loop

One loop for every "wake me when X happens", instead of a one-off watcher per wait. The orchestrator appends a **watch** (`type`, `target`, an optional `done_when`, and a `report` note saying what it wants back) to an append-only registry; `scripts/event-loop.mjs run` polls them all, compares each with its last stored state, and records an event only when the type's rule says something changed. A cheap runner, not the orchestrator, reads the result: [playbooks/event-loop.md](playbooks/event-loop.md) tells a small model how to run the loop, read the digest, and report at most ten lines.

```bash
node scripts/event-loop.mjs add --id ci-12 --type pr-checks --target owner/repo#12 --report "tell me when CI settles"
node scripts/event-loop.mjs run          # exits 10 with a digest on an actionable event, 0 when there is nothing to watch, 3 at quiet hours
node scripts/event-loop.mjs run --once   # one pass, same exit codes
node scripts/event-loop.mjs list | remove <id> | digest [--peek]
```

- **Pluggable types.** A type is a script (`scripts/event-types/<type>.mjs`: `check(target, ctx)` returns a state, `diff(prev, next)` returns events), a playbook (`playbooks/event-types/<type>.md`: what each line means and what to report), and one line in `scripts/event-types/index.mjs`. Shipped: `pr-checks` (CI status of a PR), `pr-review` (review activity, wrapping `pr-watch.mjs`; its per-watch state file is deleted when the watch retires), `gh-run` (a GitHub Actions run until it completes) and `inbox` (new messages from you). An org overlay adds its own types the same way.
- **Cadence.** The same adaptive cadence and quiet hours as the PR watcher (`scripts/lib/cadence.mjs`, nothing faster than 300 seconds). A watch expires after 24 hours unless `--ttl-hours` says otherwise and retires itself when its type says it is done. During quiet hours (including quiet weekends, and whichever `watch_quiet_hours_mode` is set) only watches registered with `--notify-overnight` keep running and notify.
- **Info events.** Informational events (for example CI going back to pending) are kept in the digest until an actionable event arrives, then printed after it; a run with only info events does not consume them.
- **Notifications.** Optional and local: set `notify_command` (a JSON argv array; the one-line summary, under 150 characters, is appended as the last argument). There is no default recipient; with it unset nothing is sent.
- **Privacy.** The `inbox` type reads the command in `inbox_command`, keeps only a hash per unread line, and reports only a count. Message text never reaches the digest, a notification or a log.
- **One loop at a time.** `run` takes a lock in `event_dir`; a second `run` is refused while the first is alive, and a dead one's lock is replaced. The lock is released on exit, Ctrl-C and SIGTERM.
- **Where it lives.** `event_dir` in local-config (default `<ledger_root>/Events`): `watches.jsonl`, `state.json`, `digest.jsonl`.
- **Cost.** One loop and one runner replace N watchers, so the orchestrator wakes once per actionable event. It is tracked as a cost experiment; see [cost/budget.md](cost/budget.md#one-event-loop-instead-of-n-watchers).

## Requirements

- Node.js 22 or newer. Nothing is installed: the scripts use only `node:` built-ins. `ledger-index.mjs` needs a Node build whose `node:sqlite` includes FTS5 (the tests ran on Node 24).
- An [Obsidian](https://obsidian.md) vault, or any directory you are willing to treat as one. The ledger is plain markdown plus a JSONL log.
- An agent harness that loads `SKILL.md` skills (Claude Code, Codex, Copilot, or anything else that reads a skill directory).
- Optional tickets: [xenophon](https://github.com/jackreichert/xenophon). Install it if you want problems to outlive the session. The maestro runs without it. See [How it works with xenophon](#how-it-works-with-xenophon).

## Install

You need one copy of this folder, on disk, where your agent already loads skills. Pick one harness as the canonical copy and symlink the others. Two edited copies drift.

```bash
# 1. Clone once. Claude Code is a fine canonical home; any path you control works.
mkdir -p ~/.claude/skills
git clone <this-repo-url> ~/.claude/skills/the-maestro

# 2. Point every other harness at that same folder. Do not clone again.
mkdir -p ~/.agents/skills
ln -s ~/.claude/skills/the-maestro ~/.agents/skills/the-maestro

# Copilot, if it reads ~/.copilot/skills:
mkdir -p ~/.copilot/skills
ln -s ~/.claude/skills/the-maestro ~/.copilot/skills/the-maestro
```

Open a new agent session in the **container** directory (the parent of your repos, not inside one repo) and ask it to orchestrate something small. If it does not load the skill, the harness is not reading that directory. Check that product's skill path and add another symlink. Do not copy the files.

Nothing else is installed. The scripts use only Node built-ins. To install it as a symlink into a checkout you keep elsewhere, point the skill directory at that checkout: `ln -s /path/to/the-maestro ~/.claude/skills/the-maestro`. The scripts find their own directory through the link.

## Set the vault

The ledger is markdown in a folder you choose. This package has no default path and will not guess one. On first use the agent should ask:

> Where should the ledger live? Absolute path to your Obsidian vault, or any folder you treat as one.

Answer with a real path, for example `/Users/you/Notes`. Then put that answer where the agent's shell will see it. `~/.zshrc` is the usual place on macOS; use whatever file your agent process actually inherits.

```bash
# In the shell profile the agent inherits. Use your path, not this one.
export VAULT_ROOT="/absolute/path/to/your/vault"
```

Open a new terminal so the variable is set, then confirm:

```bash
echo "$VAULT_ROOT"
node ~/.claude/skills/the-maestro/scripts/journal.mjs status --project <container-folder-name>
```

`--project` is required. It is the name of the container folder (the directory that holds the repos), and the ledger is created at:

```text
$VAULT_ROOT/Projects/<container-folder-name>/Journal/
```

The first `status` creates that directory if it is missing. If the command says the vault path is not set, the agent did not inherit `VAULT_ROOT`. Fix the profile, or pass `--vault /absolute/path/to/your/vault` on that one command. `--vault` overrides the variable. It does not replace setting it.

If you also install xenophon, use the same `VAULT_ROOT`. Tickets and the ledger then sit next to each other under `Projects/`.

### Optional: move the ledger out of the vault

`journal.mjs` and `prs-snapshot.mjs` are the only two scripts that write the day-to-day
`Journal/` folder (ledger, `CURRENT.md`, dated archives, `prs-snapshot.json`) — everything else
(tickets, `CONTEXT.md`, `DECISIONS.md`, `Plans/`, `Research/`, `Reviews/`) stays under
`VAULT_ROOT`, written by other skills. If that Journal folder is cluttering vault search (e.g. an
Obsidian full-text search that keeps surfacing four-character ledger ids), give it a separate root:

```bash
export LEDGER_ROOT="/absolute/path/to/a/folder/outside/the/vault"
```

Both scripts resolve their root in this order: `--vault <path>` flag, then `LEDGER_ROOT`, then
`VAULT_ROOT`. So setting `LEDGER_ROOT` alone is enough — you don't need to touch existing
`--vault "$VAULT_ROOT"` calls, and a copy of this skill that never sets `LEDGER_ROOT` keeps working
exactly as before, storing `Journal/` under `VAULT_ROOT` like it always has. Every other script
(`token-metrics.mjs`, and any xenophon/ticket tooling) keeps using `VAULT_ROOT` unchanged.

## How it works with xenophon (Tickets)

[xenophon](https://github.com/jackreichert/xenophon) is the ticket file. The maestro is the dispatcher and the day log. They are separate skills. Install xenophon against `VAULT_ROOT`; the maestro's `Journal/` can stay on `VAULT_ROOT` too, or move to its own `LEDGER_ROOT` (see [Optional: move the ledger out of the vault](#optional-move-the-ledger-out-of-the-vault)) — either way tickets and the ledger cross-link by id without the scripts calling each other.

| | the-maestro | xenophon |
|---|---|---|
| Question it answers | What is in flight, blocked, or done today? | What problem needs fixing, and what do we already know? |
| Writes | `$LEDGER_ROOT/Projects/<container>/Journal/` (falls back to `$VAULT_ROOT`) | `$VAULT_ROOT/Projects/<repo>/Tickets/` |
| Id | four characters, `k3mp` | `{repo}-014` |
| Lifetime | the session and the day; `roll` archives finished lines | until you close it |

A ticket is a problem with evidence. A ledger line is a record that work happened. Filing a ticket is itself worth a ledger line (`journal.mjs start ... --ticket billing-api-014`). The reverse is not true: do not paste the ticket body into the journal. The journal links. The ticket holds the detail.

What the agent does when both are installed:

1. Work that should survive the conversation gets a xenophon ticket first, filed against the repo it lives in. From the container directory that means `--project <repo-name>`. The container is not a git repo, so xenophon cannot infer the name.
2. The dispatch brief includes that ticket id, so the worker's findings have somewhere to land.
3. `journal.mjs start` records the activity and passes `--ticket` with that id.
4. When the work lands, the ticket is updated or closed in xenophon, and the ledger line is marked done. Closing one does not close the other.

Without xenophon, the maestro still dispatches and still keeps the journal. It just has nowhere durable to put a bug. Do not invent a second ticket system inside the journal to fill that gap.

```text
$LEDGER_ROOT/Projects/            # falls back to $VAULT_ROOT if LEDGER_ROOT is unset
    <container-name>/
        Journal/                 # maestro
            ledger.jsonl
            CURRENT.md

$VAULT_ROOT/Projects/
    <repo-name>/
        CONTEXT.md
        Tickets/                 # xenophon
            <repo-name>-001.md
            _Index.md
```

One vault, one `VAULT_ROOT`. A second vault splits the board from the tickets and the morning status can no longer point at them. `LEDGER_ROOT`, if you set one, only moves where `Journal/` itself lives — tickets and `CONTEXT.md` still resolve against `VAULT_ROOT`.

## Personalize

Do this after the smoke test, in your canonical copy. **Install-specific values live in one config file and one script, and only there.** [reference/local-config.md](reference/local-config.md) names every setting without values. [scripts/local-config.mjs](scripts/local-config.mjs) is the script side: GitHub org, login, container project name, transcript dir, ledger and vault roots, each overridable by an environment variable or by a config file. Every other file states its rule generically and points there.

Org-specific rules (repo topology, tracker rules, data rules, release steps) go in an **org overlay**: a separate skill you write for your org, kept outside this repo. Name it with `MAESTRO_OVERLAY` or `overlay:` in your config file, as a skill name (`my-org-maestro`) or a plugin-qualified one (`my-plugin:my-org-maestro`). When one is configured, the agent loads it by that name and follows it; when none is, the skill is fully generic. The overlay's `config.md` can carry the `maestro-config` block the scripts read, so its values sit next to its prose.

1. **Config file.** Create `~/.config/the-maestro/config.md` (or point `MAESTRO_LOCAL_CONFIG` at a file) with a fenced `maestro-config` block; the keys and the lookup order, including plugin skills, are in [reference/local-config.md](reference/local-config.md#config-file). For example, a file whose fenced block reads:

   ~~~text
   overlay: my-org-maestro
   gh_org: my-org
   ledger_root: /path/to/ledger
   vault_root: /path/to/vault
   ~~~

2. **Git author emails.** The skill refuses to commit on a branch you did not author. Find the emails you commit as:

   ```bash
   git log -20 --format='%ae' | sort -u
   ```

   Put those addresses in your overlay's values file, never in this repo.

   Write them under a "Standing brief block, filled" heading in that file, as described in [reference/local-config.md](reference/local-config.md#standing-brief-block-filled). `node scripts/brief-block.mjs` fails until both slots have a value.

3. **Protected branches and bases.** The default list is `main`, `staging`, and `develop`, plus any branch you did not author. Set yours in your values file, and any per-repo branch bases in your org overlay. The agent must not be told it may write those branches.

4. **Container name.** Set `project` in the config file (or `MAESTRO_PROJECT`). `journal.mjs` still requires `--project`, so a shared copy cannot write into the wrong folder.

5. **GitHub org.** Set `gh_org` in the config file (or `MAESTRO_GH_ORG`; empty drops the org filter). Your login is read from `gh api user` unless you set `gh_login` or `MAESTRO_GH_LOGIN`.

6. **PR watcher cadence (optional).** The defaults need no setup: 300s at the fastest, 1800s at the slowest, stop between 20:00 and 07:00 in your system time zone. To change them set `watch_min_interval`, `watch_max_interval`, `watch_quiet_hours` (`HH:MM-HH:MM`, or `off`), `watch_quiet_hours_mode` (`stop` or `slow`), `watch_quiet_weekends` and `watch_tz`; see [reference/local-config.md](reference/local-config.md).

7. **Event loop (optional).** `scripts/event-loop.mjs` polls registered watches and wakes you only on a state change that matters (see [The event loop](#the-event-loop)). Its registry, state and digest live in `event_dir` (default `<ledger_root>/Events`). Set `notify_command` to a JSON argv array (the one-line summary is appended as the last argument) to be notified; with it unset nothing is ever sent. `inbox_command` feeds the `inbox` type. Both are local-config only; see [reference/local-config.md](reference/local-config.md).

### Overlay lookup order

Each setting is resolved as: environment variable, then the user file, then the overlay's `config.md`.

1. The user file is `MAESTRO_LOCAL_CONFIG` (an explicit path; empty means read no file), else `~/.config/the-maestro/config.md`.
2. The overlay is named by `MAESTRO_OVERLAY` or `overlay:` in the user file: `<skill>` or, for a skill shipped in a Claude Code plugin, `<plugin>:<skill>`.
3. For `<plugin>:<skill>` the overlay's `config.md` is `<installPath>/skills/<skill>/config.md`, with `installPath` read from `~/.claude/plugins/installed_plugins.json`.
4. Otherwise, or if that misses, it is `../<skill>/config.md` next to this skill (found through a symlink too), then `~/.claude/skills/<skill>/config.md`.

Run `node scripts/local-config.mjs` to see what resolved and from which file. The full key list is in [reference/local-config.md](reference/local-config.md#config-file).

### Optional: keep a private overlay on a local-only branch

If you keep this repo public but want your org overlay versioned next to it, put the overlay on a branch that never leaves your machine, in its own worktree:

```bash
git worktree add ../the-maestro-private -b local/private feat/my-branch
# add overlays/<skill>/ (SKILL.md, config.md, ...) on that branch and commit it there
# install: symlink the worktree as the skill, and the overlay dir as its own skill
ln -s "$PWD/../the-maestro-private" ~/.claude/skills/the-maestro
ln -s "$PWD/../the-maestro-private/overlays/<skill>" ~/.claude/skills/<skill>
```

Keep it in step by merging the public branch into it (`git -C ../the-maestro-private merge --no-edit <public-branch>`), one direction only. Guard the boundary with a `pre-push` hook in the shared hooks directory (`.git/hooks/pre-push`, which every worktree uses; hooks are not versioned). It refuses any push that names a `local/*` ref, and any push whose added lines match a list of private patterns kept in `.git/hooks/private-patterns.txt`, one extended regex per line:

```sh
#!/bin/sh
# pre-push: keep local-only branches and private content off the remote.
zero=0000000000000000000000000000000000000000
patterns="$(git rev-parse --git-common-dir)/hooks/private-patterns.txt"
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_ref $remote_ref" in
    *refs/heads/local/*) echo "pre-push: refusing $local_ref, a local-only branch" >&2; exit 1 ;;
  esac
  [ "$local_sha" = "$zero" ] && continue
  [ -s "$patterns" ] || continue
  if [ "$remote_sha" = "$zero" ]; then range="$local_sha --not --remotes=$1"; else range="$remote_sha..$local_sha"; fi
  for c in $(git rev-list $range); do
    if git show --format= -p "$c" | grep '^+' | grep -qiE -f "$patterns"; then
      echo "pre-push: commit $c adds content matching a private pattern; refusing" >&2; exit 1
    fi
  done
done
exit 0
```

Make it executable, and check it with `git push --dry-run origin local/private` (must be refused) and `git push --dry-run origin <public-branch>` (must pass). Never pass `-u` for the local branch.

## What the agent is expected to do

Trigger it from the **container** directory — the parent of the repos — not from inside a single checkout.

It should:

1. Resolve which repo the request is about.
2. Dispatch a read-only scout before grepping itself, then return to you with a one-line ack.
3. File durable work as a ticket (xenophon) rather than a chat TODO.
4. Launch a worker with a self-contained brief. The worker does not see the parent conversation. The brief's fields and the standing rules block every brief carries are in [reference/brief.md](reference/brief.md). `node scripts/brief-block.mjs` prints that block with its two install-specific slots filled from your config, and exits non-zero if any is left empty. Each brief names a write scope and a verify command; a field the dispatcher cannot fill means scouting again.
5. End the turn. It must not poll a running agent.
6. Log the work, relay the result when it lands, and end every reply with the live agent roster and ledger counts.

A new message while agents are running is normal. It handles the new request alongside or after the current one, and only stops if you contradict the work in hand.

## The ledger

Storage, under `$LEDGER_ROOT/Projects/<project>/Journal/` (falls back to `$VAULT_ROOT` if `LEDGER_ROOT` is unset; both can also be set in the [config file](#personalize)):

| File | Role |
|---|---|
| `ledger.jsonl` | Append-only source of truth. One JSON object per line. |
| `CURRENT.md` | Generated board: open items plus what finished today. Safe to read; regenerated from the log. |
| `YYYY-MM-DD.md` | Generated daily archive, written by `roll`. |
| `Streams/<Stream>.md` | Generated per-stream page, written by every `render`: that stream's in flight, blocked, awaiting and done today. An archived stream's page links its retro. |

Every new entry needs `--model "<name>"` and `--used "skill:x,tool:y"`, so the record says which model did the work with what. Do not invent either: unknown history is `unrecorded`, unmeasured tokens are `unmeasured` (`--allow-unmarked` is only for tests and migrations).

```bash
J=~/.claude/skills/the-maestro/scripts/journal.mjs
M=(--model "Some Model" --used "skill:the-maestro,tool:journal.mjs")

node $J start "Port the calendar fix onto the feature branch" --repo billing-api --ticket billing-api-014 "${M[@]}"
node $J done  "Port the calendar fix" "${M[@]}"      # id or a unique substring
node $J ask   "Split this into a follow-up PR?" "${M[@]}"
node $J resolve "follow-up" --answer "Yes, no consumer yet" "${M[@]}"
node $J status                               # open items + done today
node $J standup                              # end-of-day summary, ready to paste
node $J roll                                 # archive the day, keep open items
node $J status --footer                      # the reply-footer Ledger lines, one per active stream
node $J handoff --stream Launch              # scaffold the five-part handoff (see below)
node $J resume                               # the verify-on-resume checklist
node $J log "<text>" --kind decision --approval standing --scope "<what it covers>"   # log a granted permission (standing | one-off)
node $J approvals --days 7                   # the weekly approvals review doc (keep / narrow / revoke)
```

Also: `log`, `drop`, `stamp`, `stamp-missing`, `usage`, `render`. Common flags: `--vault`, `--project`, `--json`, `--dry-run`, `--include-archived`. `--project` is required; there is no default project name.

Kinds: `wip`, `done`, `blocked`, `question`, `decision`, `note`, plus `resolved`, `dropped`, `rolled` and `stamp` (written by their own commands).

`roll` writes the day's finished work to a dated note and leaves in-flight, blocked, and awaiting-you items on the board. Roll at end of day, or when `CURRENT.md` is longer than a screen.

Ledger ids are four lowercase characters (`k3mp`). They are not tickets and they are not issue-tracker keys. When you mention one, include the one-liner, not the bare id.

### Streams, facts, retro, carry, archive

A stream is a named workstream, usually an epic. Pass `--stream <name>` to `start`, `log`, `ask` and `fact`, or file an existing item with `tag`; `status`, `standup` and `render` show each stream in its own section first.

```bash
node $J tag <id> --stream Launch                    # file an existing item under a stream
node $J tag <id> --stream none                      # clear it; `none` is reserved and never a stream name
node $J streams add Launch --alias launch,launch-v2   # the registry: aliases and case fold to one name
node $J streams list                                # counts per stream
node $J streams check                               # dry run: how many rows would change display stream; appends nothing
node $J fact visits_full_min=79 --stream Launch "${M[@]}"   # a structured metric; not an item, never open
node $J carry <id> --to Maintenance "${M[@]}"       # re-home an open follow-up to another stream
node $J retro Launch [--out <path>] [--force] --tickets-vault "$VAULT_ROOT"   # draft the retro doc (status: draft)
node $J archive Launch "${M[@]}"                    # hide a finished stream
node $J unarchive Launch "${M[@]}"                  # bring it back, exactly
```

If `$LEDGER_ROOT/Projects/<project>/streams.json` exists it is the registry: names are folded to the canonical spelling on write and on read, an unknown name is rejected with a suggestion unless you pass `--new-stream`, and an archived stream rejects writes. Without the file nothing is enforced. `archive` refuses while the stream has open items (carry them elsewhere first), until the retro is no longer a draft, and until its promotions are filled in. `retro` and `archive` read ticket status through `ledger-index.mjs`, so they need `--tickets-vault` (or `VAULT_ROOT`).

### Per-stream views

`render` (which every write also runs) rebuilds `CURRENT.md` and one `Journal/Streams/<Stream>.md` per active stream. `CURRENT.md` stays the combined board, grouped by stream, and each stream's heading carries a `[[Streams/<Stream>]]` link. A stream page shows only that stream: in flight, blocked, awaiting you and done today, with `_none_` for an empty section. Registered streams with nothing open still get a page, so a quiet one reads `_none_` instead of going stale. An archived stream's page says so and links its retro; `CURRENT.md` lists archived streams under "Archived streams". All of these are generated and overwritten.

The streams live in **one** ledger. The JSONL is deliberately not split per stream: a single file keeps ordering, ids and `carry` (which moves an item between streams) simple, and it is safe with one writer at a time. Views are cheap to generate; a split ledger would make every cross-stream move a multi-file write. Rationale in [reference/ledger.md#per-stream-views](reference/ledger.md#per-stream-views).

### Integrity and backup

```bash
node $J verify [--json]      # exit 1 and a list if anything is wrong
```

`verify` reads the raw ledger file and checks that every line parses as a JSON object, that ids are unique, and that every `closes`, `carries`, `tags`, `annotates` and archive `ids` reference points at a row that exists. It prints `verify: N row(s), K problem(s)` with a line number and id per problem, and exits non-zero on any. A missing ledger is not a problem.

The ledger is one file, so a bad edit or a lost disk loses everything. An optional backup uses git: make `$LEDGER_ROOT` a git repository (local only; no remote is needed), add a `.gitignore` for `**/Index/*.sqlite` and temp files, and set `ledger_git_autocommit: on` in the config file (or `MAESTRO_LEDGER_GIT_AUTOCOMMIT=on`). Then `roll` runs `verify` first and, if it passes, commits the changed files under the ledger root as `chore(ledger): roll <date>`, staging each path explicitly with `git add -- <path>` (never `-A`) and committing only those paths. If verify fails, nothing is committed and `roll` exits 1. If the root is not itself a git repository the setting is ignored with a note. Off by default. It never pushes.

### Repo claims

One writer per repo is easy inside one session (`ListAgents` shows who is running) and impossible to see across sessions. A claim is a lock file every session can see.

```bash
node $J claim billing-api --desk Launch [--branch feat/x] [--why "porting the fix"] [--pid <session pid>] "${M[@]}"
node $J release billing-api --desk Launch "${M[@]}"          # only the holding desk; --force overrides
node $J claims [--stale-hours 12] [--json]                   # who holds what, with a stale check
```

`claim` creates `$LEDGER_ROOT/Projects/<project>/Claims/<repo>.lock` (desk, pid, host, time, branch, why) with an exclusive create (`O_CREAT|O_EXCL`), so of any number of racing processes exactly one wins; the losers exit 1 and name the holder. A `claim` row goes to the ledger as the record and `release` appends `released`. Neither is an item, so they never show as open. `claims` flags a claim as stale when its pid is not running on this host, or when it is older than `--stale-hours` (default 12). A claim with no `--pid` is judged on age alone: the short-lived shell that runs the command is not a useful pid, so pass the long-lived desk session's pid if you want the liveness check. Nothing deletes a stale claim for you; `release --force` is a decision. See [reference/desks.md](reference/desks.md) (draft) for how this fits a hub-and-desks setup.

Appends are safe across concurrent writers: each row is one `write()` on an `O_APPEND` file, and the tests run several processes appending at once and check that every line parses, ids are unique and none are lost. Ids are chosen by reading the ledger first, so two writers picking the same four characters in the same instant is possible in principle (about one in 1.7 million per pair); `verify` reports duplicate ids if it ever happens.

### Desks (draft)

[reference/desks.md](reference/desks.md) describes one hub session plus one desk session per stream: who owns what, how claims keep two sessions out of one repo, and when a desk rolls (a phase boundary past about 100 turns, with a 180-turn backstop). It is a draft: the pieces exist, the protocol has not been run for a full day.

### Backfill: filing old untagged items

Items logged before streams existed have none. `backfill` proposes one for each and, after you have reviewed the proposals, files them with appended `tag` rows. The ledger is never rewritten.

```bash
node $J backfill [--dry-run] [--samples 3] [--out report.md] [--json]   # the default: counts and samples, appends nothing
node $J backfill --apply --min-confidence high "${M[@]}"                  # append the tag rows (one batch, one render)
```

Signals, all weighed against how the already-tagged items are filed, and the registry: a shared **ticket** id (4 points when every tagged item with it is in one stream, 1 otherwise), a **keyword** (the registry name or an alias, whole word, 2 points, only when exactly one stream matches), the **repo** (2 points when 90%+ of 5+ tagged items in it share a stream, else 1; a catch-all repo stays weak), and the **session** (a run of rows with no gap over 30 minutes; if the tagged items in it agree, 1 point). Proposals agreeing on a stream add up: 4+ is `high`, 2 or 3 `medium`, 1 `low`. Signals that disagree cap the proposal at `low`, and a tie proposes nothing. Archived streams are never proposed. The dry run prints counts per stream and confidence, samples, and how many items got no proposal (a legitimate state); `--out` writes the whole `id | date | kind | repo | ticket | proposed | confidence | rules` table for review.

`--apply --min-confidence <level>` (default `high`) appends one `tag` row per proposal at or above that level, each carrying `backfill` (a run id), `rule`, `confidence` and `prev` (the stream before, `null` for none), plus the usual `--model` and `--used`. Re-running is a no-op because tagged items are no longer proposals. Review the dry run first; applying is the human's call.

### Handoff and resume

A fresh session should not have to hunt for facts nobody wrote down. `handoff` scaffolds the five-part note from the ledger; `resume` is what the fresh session runs first. The fresh session reconciles the note against `git`, `gh` and `ListAgents` before acting, then treats it as authoritative ([cost/budget.md](cost/budget.md#session-hygiene)).

```bash
node $J handoff --stream Launch [--out <path>] [--since YYYY-MM-DD] [--force]
node $J resume
```

`handoff` writes `Journal/HANDOFF-<date>-<stream>.md` (`status: draft`; the derived index already picks these up) and appends nothing to the ledger. It **never overwrites** an existing file without `--force`. The five parts: (1) tasks with status, the stream's open in-flight and blocked items plus what was done since `--since` (default yesterday); (2) learnings, from items matching learned, lesson, ruled out or cause; (3) artifacts, the PR numbers, refs, tickets and file paths mentioned by those items; (4) decisions awaiting, the open questions and decisions; (5) next concrete action, left blank for the author. Sections 2 and 5 still need a human.

`resume` prints the checklist and runs the parts a script can: the ledger status, `gh pr list --author @me --state open --json number,title,url` (`gh: unavailable` when it is missing or fails; the command still exits 0), and `pgrep -f` for each configured loop pattern (`ok` or `MISSING`). It ends with a reminder that **`ListAgents` is a harness tool, not a shell command**, so the session calls it itself. The loop patterns and whether `gh` is used come from local config (`loop_patterns`, `resume_gh`, or `MAESTRO_LOOP_PATTERNS`, `MAESTRO_RESUME_GH`; see [reference/local-config.md](reference/local-config.md)). Nothing is hardcoded.

### Model names

`--model` values drift ("Claude Opus 5.5" and "claude-opus-5-5" are the same model, and per-model rollups split in two). A `models` section in the same `streams.json` fixes it the way streams are fixed: canonical id plus aliases, applied on write and on read.

```bash
node $J models add claude-opus-5-5 --alias "Claude Opus 5.5,opus"   # idempotent; refuses an alias owned by another id
node $J models list                                                 # ids, aliases, row counts
node $J models check                                                # dry run: which old spellings would show under which id; appends nothing
```

An alias is written as the canonical id (`normalised model opus -> claude-opus-5-5` on stderr). An unknown name **warns and is written as-is** (the ledger has odd historic values; nothing is rejected), and `unrecorded`, `n/a` and `unmeasured` never warn. Old rows are healed on read, so `usage` and `status` show one name and the ledger is not rewritten. With no `models` section nothing changes. A registry file with only `models` does not turn on stream enforcement.

### The derived index

`scripts/ledger-index.mjs` builds a disposable SQLite FTS5 index over the ledger rows, the vault tickets, and each `##` section of `HANDOFF-*.md` notes. The JSONL stays the source of truth: deleting `Index/maestro.sqlite` loses nothing.

```bash
I=~/.claude/skills/the-maestro/scripts/ledger-index.mjs

node $I index                                   # full rebuild, atomic rename into place
node $I search "calendar fix" [--source ledger|tickets|handoffs|archive] [--stream X] [--limit 20] [--json]
node $I stats [--json]                          # counts per table, open items per stream
node $I query                                   # lists the named queries
node $I query open --stream Launch              # one of them; `query --sql "select ..."` is read-only raw SQL
```

The named queries are `open`, `by-ticket` (takes a ticket id or an external tracker key such as `PROJ-123`, matched against the ticket's `external` field with or without its `<tracker>-` prefix), `untagged`, `stream-counts`, `handoffs` and `tickets`. `search` rebuilds first if a source changed. Items of archived streams are hidden unless you pass `--include-archived`. Pass `--vault` and `--tickets-vault` the way `journal.mjs` does.

### Tests

```bash
node --test scripts/*.test.mjs
```

`scripts/lib/ledger-core.mjs` holds what both `journal.mjs` and `ledger-index.mjs` need to agree on: the fold, `isOpen`, and the stream-registry lookup. Change it there, once.

The tests run each script as a subprocess against a temporary ledger and never read your own config file (each test file sets `MAESTRO_LOCAL_CONFIG=''`).

## What this is not

- Not a project manager and not a ticket database. Problems that need fixing belong in xenophon (or your issue tracker). The ledger is a record of activity.
- Not safe to run two dispatcher sessions that both `start` / `done` the same ledger without looking. The log is append-only and last-write wins on the generated markdown.
- Not a license to write `main`, `staging`, `develop`, or a branch you did not author. Those stay protected. Pull requests open as drafts.

## Sharing

This folder is the shareable unit: `SKILL.md`, `reference/`, `cost/`, `scripts/` (with their tests), and this README. It ships no org overlay; write your own and name it as described in Personalize. State files the scripts write at run time (`prs-snapshot.json`, `pr-watch-state.json`) live under your ledger root, not here, and must not be shipped. It contains no vault data, no tickets, and no secrets.

Do not commit your vault's `Journal/` or `Projects/` tree into this repo. Those are your notes. Point the script at them with `VAULT_ROOT`, or `LEDGER_ROOT` if you keep the ledger outside the vault.

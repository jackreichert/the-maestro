# the-maestro

Orchestrate work from a directory that **contains** many git repos, rather than from inside one of them. The agent at that root is a dispatcher: it routes work to background agents, keeps the prompt free, and keeps a ledger of what is done, in flight, and waiting on you.

It does not implement features itself. Implementation happens in the target repo, on a brief the dispatcher writes.

## What you get

- A session protocol: resolve the repo, scout, ticket, dispatch, relay, then close with a status footer.
- A greeting that always comes back with today's board, not just "hey".
- An append-only ledger so "what did we get done today?" is already written down.
- Rules for one writer per repo, worktrees only when a checkout is actually busy, and draft-only pull requests.

The protocol is in [SKILL.md](SKILL.md). The ledger tool is [scripts/journal.mjs](scripts/journal.mjs).

## Requirements

- Node.js 18 or newer (the script uses only `node:` built-ins; nothing to install).
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

Nothing else is installed. `scripts/journal.mjs` uses only Node built-ins.

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

## How it works with xenophon (Tickets)

[xenophon](https://github.com/jackreichert/xenophon) is the ticket file. The maestro is the dispatcher and the day log. They are separate skills. Install both, point them at the same `VAULT_ROOT`, and they share one `Projects/` tree without calling each other.

| | the-maestro | xenophon |
|---|---|---|
| Question it answers | What is in flight, blocked, or done today? | What problem needs fixing, and what do we already know? |
| Writes | `$VAULT_ROOT/Projects/<container>/Journal/` | `$VAULT_ROOT/Projects/<repo>/Tickets/` |
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
$VAULT_ROOT/Projects/
    <container-name>/
        Journal/                 # maestro
            ledger.jsonl
            CURRENT.md
    <repo-name>/
        CONTEXT.md
        Tickets/                 # xenophon
            <repo-name>-001.md
            _Index.md
```

One vault, one `VAULT_ROOT`. A second vault splits the board from the tickets and the morning status can no longer point at them.

## Personalize

Do this after the smoke test, in your canonical copy of `SKILL.md`. The published file uses placeholders on purpose.

1. **Git author emails.** The skill refuses to commit on a branch you did not author. Find the emails you commit as:

   ```bash
   git log -20 --format='%ae' | sort -u
   ```

   Put those addresses in the branch-authorship section of `SKILL.md`, replacing the instruction to discover them. Do not leave someone else's addresses in a copy you publish.

2. **Protected branches.** The default list is `main`, `staging`, and `develop`, plus any branch you did not author. If your repos protect different names, change that list in `SKILL.md`. The agent must not be told it may write those branches.

3. **Container name.** You already passed it as `--project`. If you always work from one container, you can note that name in `SKILL.md` so the agent stops asking. Do not hardcode it in `journal.mjs`. The script requires `--project` so a shared copy cannot write into the wrong folder.

4. **Issue tracker, optional.** Skip this if you have no tracker MCP. If you do (Jira via the Atlassian MCP is the one the skill knows how to call), tell the agent the site and project key once, in `SKILL.md` or in the vault's project `CONTEXT.md`. Example shape, not a real site: `project = TOOL`, browse links `https://example.atlassian.net/browse/TOOL-123`. The morning board includes a sprint section only when that MCP is installed and connected. If it is not installed, the section is omitted and not mentioned.

5. **Greeting.** The skill greets, then gives the board. Leave that. Change only the tone if you want a shorter hello. Do not remove the board step.

Re-read `SKILL.md` before you share your fork. If a name, email, host, or ticket key in it is yours, take it out of the copy other people will clone.

## What the agent is expected to do

Trigger it from the **container** directory — the parent of the repos — not from inside a single checkout.

It should:

1. Resolve which repo the request is about.
2. Dispatch a read-only scout before grepping itself, then return to you with a one-line ack.
3. File durable work as a ticket (xenophon) rather than a chat TODO.
4. Launch a worker with a self-contained brief. The worker does not see the parent conversation.
5. End the turn. It must not poll a running agent.
6. Log the work, relay the result when it lands, and end every reply with the live agent roster and ledger counts.

A new message while agents are running is normal. It handles the new request alongside or after the current one, and only stops if you contradict the work in hand.

## The ledger

Storage, under `$VAULT_ROOT/Projects/<project>/Journal/`:

| File | Role |
|---|---|
| `ledger.jsonl` | Append-only source of truth. One JSON object per line. |
| `CURRENT.md` | Generated board: open items plus what finished today. Safe to read; regenerated from the log. |
| `YYYY-MM-DD.md` | Generated daily archive, written by `roll`. |

```bash
J=~/.claude/skills/the-maestro/scripts/journal.mjs

node $J start "Port the calendar fix onto the feature branch" --repo billing-api --ticket billing-api-014
node $J done  "Port the calendar fix"        # id or a unique substring
node $J ask   "Split this into a follow-up PR?"
node $J resolve "follow-up" --answer "Yes — no consumer yet"
node $J status                               # open items + done today
node $J standup                              # end-of-day summary, ready to paste
node $J roll                                 # archive the day, keep open items
```

Also: `log`, `drop`, `render`. Common flags: `--vault`, `--project`, `--json`, `--dry-run`.

Kinds: `wip`, `done`, `blocked`, `question`, `decision`, `note`.

`roll` writes the day's finished work to a dated note and leaves in-flight, blocked, and awaiting-you items on the board. Roll at end of day, or when `CURRENT.md` is longer than a screen.

Ledger ids are four lowercase characters (`k3mp`). They are not tickets and they are not issue-tracker keys. When you mention one, include the one-liner, not the bare id.

## What this is not

- Not a project manager and not a ticket database. Problems that need fixing belong in xenophon (or your issue tracker). The ledger is a record of activity.
- Not safe to run two dispatcher sessions that both `start` / `done` the same ledger without looking. The log is append-only and last-write wins on the generated markdown.
- Not a license to write `main`, `staging`, `develop`, or a branch you did not author. Those stay protected. Pull requests open as drafts.

## Sharing

This folder is the shareable unit: `SKILL.md`, `scripts/journal.mjs`, and this README. It contains no vault data, no tickets, and no secrets.

Do not commit your vault's `Journal/` or `Projects/` tree into this repo. Those are your notes. Point the script at them with `VAULT_ROOT`.

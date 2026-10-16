# Playbook: draft replies to comments on your own PRs

Trigger: a `THREAD`, `REPLY` or `COMMENT` line from `pr-watch` ([event-types/pr-watch.md](event-types/pr-watch.md)) on a PR you authored. Script: `node scripts/reply-drafts.ts` (`threads`, `submit`). Model: Haiku runs the commands; one Sonnet agent writes the replies.

The rule, enforced in code: a reply to a thread with a person in it never posts itself. It becomes a draft in the approval queue and waits on the Podium's Open PRs tab for Approve, Edit or Reject. A thread where every other participant is a bot (Copilot, a security scanner) is answered directly and resolved, with no approval.

## Steps

1. `threads --repo <owner/name> --pr <n>` prints each unresolved thread that waits on you: `commentId` (the thread's first comment, the id to answer), `kind` (`human` or `bot`), the file and line, and the last comments. It refuses a PR that is not yours.
2. Dispatch one agent to write one reply per thread you intend to answer, in your first person, friendly and polite, never mentioning an assistant or a tool. For each: `kind` is `fixed` (say what the commit did, with its short sha when there is one), `decline` (a reasoned decline: say why, plainly) or `question` (ask what you need to know). Read the code the comment is about before answering; do not promise a change that was not made.
3. `submit < replies.json` with `{ "repo": "<owner/name>", "pr": <n>, "replies": [ { "commentId": N, "kind": "fixed", "text": "..." } ] }`. It prints one result per reply: `queued` (a human thread; waiting for your approval), `posted` (a bot thread; answered, and resolved for `fixed` and `decline`) or `refused` with the reason.
4. Say how many were queued and how many posted. A `refused` line is fixed and submitted again, never worked around.

## Do not

Answer a Copilot thread on a develop PR that is about code only on staging: ignore it, it is drift from the base branch.

Post a reply to a person yourself with `gh`. The queue and the Podium are the only way a human's thread is answered. Fixing the code a bot asked about comes first; the reply only reports it.

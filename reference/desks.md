---
status: draft
---
# Desks: one hub session plus one desk session per stream

**Status: draft.** This describes a protocol nobody has run for a full day yet. The mechanics it leans on (`claim`, `release`, `claims`, `handoff`, `resume`, `status --footer`) exist and are tested; the rules below are proposals to try and then correct.

A **desk** is one long-lived session that owns one stream, usually a project spanning several repos. The **hub** is the session that sees all of them. Both read and write the same ledger. The ledger is not split per desk: one file keeps ordering, ids and `carry` simple, and it is safe with concurrent appenders ([ledger.md#claims](ledger.md#claims)).

## Roles

**Hub**
- Gives the greeting board across every stream (`status`, `status --footer`).
- Runs the PR pass, end of day, and the tracker review.
- Owns cross-stream questions, and `carry`s an item between streams when it belongs elsewhere.
- Dispatches **read-only** work only, and never a writer into a repo that `claims` shows as held.

**Desk**
- Owns one stream. Logs with `--stream <Desk>` and nothing else.
- Claims a repo before dispatching a writer into it, and releases the claim when the work lands.
- Writes its own handoff (`handoff --stream <Desk>`) before it rolls, and starts every fresh session with `resume`.

## Claims

A claim is the cross-session form of one-writer-per-repo. `ListAgents` only sees the current session's agents, so it cannot tell a desk that another session is already writing a repo.

```bash
node $J claim <repo> --desk <Stream> --pid <session pid> "${M[@]}"   # exclusive; exit 1 and the holder's name if taken
node $J claims                                                       # what is held, by whom, how old, stale or not
node $J release <repo> --desk <Stream> "${M[@]}"
```

- A desk claims **before** it dispatches a writer, and releases **after** the work lands (PR opened and pushed, or abandoned), not at the end of the day.
- The hub reads `claims` before any dispatch. A held repo is off limits to it.
- A stale claim (dead pid, or older than the threshold) is reported, never cleared automatically. A person decides, then `release --force`.
- A desk that needs a repo another desk holds asks through the hub (a `question` item), rather than forcing the lock.

## Roll triggers

A long session gets expensive and forgetful. A desk rolls (writes its handoff, ends, and a fresh session starts from `resume`) at:

1. **A phase boundary once the session is past about 100 turns.** A phase boundary is a natural seam: a PR opened or merged, a release shipped, a runbook step closed. Rolling there loses the least.
2. **The 180-turn backstop.** If no seam has appeared by then, roll anyway, and say so in the handoff.

The existing budget nudges in [cost/budget.md#session-hygiene](../cost/budget.md#session-hygiene) still apply to the hub.

Before rolling: release every claim the session holds, `handoff --stream <Desk>`, edit sections 2 and 5 by hand, then `roll`.

## Open questions

- Who opens desk sessions, and does the hub ever dispatch a writer, or do only desks?
- Should `status` show a Claims section, so the hub sees them without a second command?
- Is 100 turns the right threshold? Measure the read-per-turn curve on a real day before fixing it.

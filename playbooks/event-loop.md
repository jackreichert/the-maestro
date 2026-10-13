# Playbook: run the event loop (for a cheap runner)

You are the runner. The orchestrator registers watches; you run the loop, read what it found, and report only what needs a person. You do not fix, reply, merge, re-run or investigate anything. You report and stop.

## 1. Wait on the inbox

```bash
node scripts/event-loop.ts list
node scripts/event-loop.ts events wait
```

The launchd supervisor is the only runner: it keeps `run --serve` alive, which polls every live watch (cadence in [cost/budget.md](../cost/budget.md#pr-watcher-cadence)) and writes each event to the inbox (`<event_dir>/events.jsonl`). A plain `run` refuses while the supervisor is installed, so you never start the loop yourself. `events wait` is the one thing you run: start it in the background; its completion wakes you.

| Exit | Meaning | You do |
|---|---|---|
| 10 | New events. Stdout is the event lines. | Step 2. |
| 0 | Nothing new before the timeout. | Report one line: nothing to do. |
| 2 | Usage or configuration error. | Report the stderr line. Do not retry or delete the lock. |

Read the inbox with `node scripts/event-loop.ts events`, and when an event is dealt with run `events ack <id>`. Event lines carry a kind, the watch and `repo`/`number`/`who`/`count` only; open the PR or thread yourself for the rest. Digests the loop saved while no session was waiting are moved into the inbox by the supervisor; `digest-wait` is an alias for `events wait`.

For one quick look, `node scripts/event-loop.ts run --once` does a single pass.

## 2. Read the digest

Each line is `ACTION <watch id> (<type>): <summary> | report: <hint>` or `info ...`. `ACTION` lines come first.

- Open the playbook for each type that appears: `playbooks/event-types/<type>.md`, or `event-types/<type>.md` in the org overlay for a type the overlay added. Its table says what the line means and what to report.
- `info` lines are kept from earlier quiet runs and show up with the next actionable batch. They are context, not news.
- The loop marks actionable events; the type playbook is what you confirm them against. Do not promote an `info` line, and do not drop an `ACTION` line because it looks small. If a line is not in its type's table, report it as it is.
- The `report:` hint is the orchestrator's own note on what it wants back. Follow it when it asks for something the type playbook allows.

## 3. Report back (at most 10 lines)

One line per actionable event: watch id, what happened, the link or name from the digest. Then one line saying whether the loop is still running or has exited, and which watches remain (`node scripts/event-loop.ts list`). Nothing else: no logs, no JSON, no message text.

If a watch reports `check keeps failing`, say so; it means the check could not run (a missing command, an expired login), not that nothing happened.

## Hard rules

- Personal data stays out of your report. The `inbox` type reports a count only; never run the inbox command yourself and never quote a message.
- Do not send notifications. If the install has a `notify_command`, the loop already sent it for the watches that opted in with `--notify`.
- Do not edit the registry except as the orchestrator told you to. `remove <id>` retires a watch; `add` registers one.

## For the orchestrator: registering a watch

```bash
node scripts/event-loop.ts add --id <id> --type <type> --target <target> \
  [--done-when <rule>] [--report "<what you want back>"] [--ttl-hours N] [--interval S] [--notify | --no-notify] [--notify-overnight]
```

A watch expires after 24 hours unless `--ttl-hours` says otherwise, and retires itself when its type says it is done. Each type polls at its own pace (`inbox` 60s, `pr-checks` 180s, `pr-watch` 600s (floor 300s), `gh-run` 120s, `reminder` 30s); `--interval S` overrides it, but never below 120s for a type that calls GitHub (300s for `pr-watch`) or 30s for a local one. Only watches added with `--notify` are sent to `notify_command`; a reminder is by default, `--no-notify` silences it, and the inbox never notifies. This replaces writing a one-off watcher script. Types: [pr-checks](event-types/pr-checks.md), [pr-watch](event-types/pr-watch.md) (`pr-review` is its old name), [gh-run](event-types/gh-run.md), [inbox](event-types/inbox.md), [reminder](event-types/reminder.md) (a one-time wake-up: `--type reminder --target <ISO 8601 UTC> --report "<text>"`).

## For the orchestrator: adding an event type

1. `scripts/event-types/<type>.ts` exporting `check(target, ctx) -> state` and `diff(prev, next) -> events[]` (and optionally `done(state, watch)`, and `retired(watch, ctx)` to delete per-watch files when the watch retires). `ctx.watch` is the watch (with its `created` time) and `ctx.prev` the state `check` returned last time (null on the first check), for a baseline. `ctx.run(cmd, args)` runs a command and returns `{ status, stdout, stderr }`; use it so tests can stub it. Treat `prev === null` as the first check and report only what is already worth waking for.
2. `playbooks/event-types/<type>.md`: what each digest line means, which are actionable, what to report, what never to do.
3. One line in `scripts/event-types/index.ts`.
4. Tests with fixtures and no network. `node --test scripts/event-types.test.ts` fails if a type has no playbook.

An org overlay adds a type with steps 1 and 2 only, no index line: `<overlay dir>/event-types/<type>.mjs` (or `.ts`) and `<overlay dir>/event-types/<type>.md`, where the overlay dir holds the overlay's `config.md`. The loop loads them on start; a duplicate name, a module without `check`/`diff` functions or a missing playbook is an error, not a skipped file.

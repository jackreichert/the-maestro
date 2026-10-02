# Playbook: run the event loop (for a cheap runner)

You are the runner. The orchestrator registers watches; you run the loop, read what it found, and report only what needs a person. You do not fix, reply, merge, re-run or investigate anything. You report and stop.

## 1. Run it

```bash
node scripts/event-loop.mjs list
node scripts/event-loop.mjs run
```

`run` polls every live watch, sleeps between ticks (never faster than 300 seconds; the cadence is in [cost/budget.md](../cost/budget.md#pr-watcher-cadence)), and exits when there is something to say. It is the one long-running process in this design, so start it in the background and wait for it to finish; its completion wakes you, not the orchestrator.

| Exit | Meaning | You do |
|---|---|---|
| 10 | Actionable events. Stdout is the digest. | Step 2. |
| 0 | Nothing to do (`no watches registered`, or `run --once` found nothing). | Report one line: the loop has nothing to watch. |
| 3 | Quiet hours or a quiet weekend began (`QUIET-HOURS stop until <time>`); no `--notify-overnight` watch is live. | Report one line with the time. |
| 2 | Usage or configuration error, or `another event loop is running`. | Report the stderr line. Do not retry or delete the lock. |

For one quick look instead of a long wait, `node scripts/event-loop.mjs run --once` does a single pass with the same exit codes.

## 2. Read the digest

Each line is `ACTION <watch id> (<type>): <summary> | report: <hint>` or `info ...`. `ACTION` lines come first.

- Open the playbook for each type that appears: `playbooks/event-types/<type>.md`. Its table says what the line means and what to report.
- `info` lines are kept from earlier quiet runs and show up with the next actionable batch. They are context, not news.
- The loop marks actionable events; the type playbook is what you confirm them against. Do not promote an `info` line, and do not drop an `ACTION` line because it looks small. If a line is not in its type's table, report it as it is.
- The `report:` hint is the orchestrator's own note on what it wants back. Follow it when it asks for something the type playbook allows.

## 3. Report back (at most 10 lines)

One line per actionable event: watch id, what happened, the link or name from the digest. Then one line saying whether the loop is still running or has exited, and which watches remain (`node scripts/event-loop.mjs list`). Nothing else: no logs, no JSON, no message text.

If a watch reports `check keeps failing`, say so; it means the check could not run (a missing command, an expired login), not that nothing happened.

## Hard rules

- Personal data stays out of your report. The `inbox` type reports a count only; never run the inbox command yourself and never quote a message.
- Do not send notifications. If the install has a `notify_command`, the loop already used it.
- Do not edit the registry except as the orchestrator told you to. `remove <id>` retires a watch; `add` registers one.

## For the orchestrator: registering a watch

```bash
node scripts/event-loop.mjs add --id <id> --type <type> --target <target> \
  [--done-when <rule>] [--report "<what you want back>"] [--ttl-hours N] [--notify-overnight]
```

A watch expires after 24 hours unless `--ttl-hours` says otherwise, and retires itself when its type says it is done. This replaces writing a one-off watcher script. Types: [pr-checks](event-types/pr-checks.md), [pr-review](event-types/pr-review.md), [gh-run](event-types/gh-run.md), [inbox](event-types/inbox.md).

## For the orchestrator: adding an event type

1. `scripts/event-types/<type>.mjs` exporting `check(target, ctx) -> state` and `diff(prev, next) -> events[]` (and optionally `done(state, watch)`, and `retired(watch, ctx)` to delete per-watch files when the watch retires). `ctx.run(cmd, args)` runs a command and returns `{ status, stdout, stderr }`; use it so tests can stub it. Treat `prev === null` as the first check and report only what is already worth waking for.
2. `playbooks/event-types/<type>.md`: what each digest line means, which are actionable, what to report, what never to do.
3. One line in `scripts/event-types/index.mjs`.
4. Tests with fixtures and no network. `node --test scripts/event-types.test.mjs` fails if a type has no playbook.

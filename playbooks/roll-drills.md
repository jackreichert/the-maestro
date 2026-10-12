# Playbook: the continuous-roll drills (for a cheap runner)

You are the runner. The drills check that a new session rebuilds everything from outside its window, whatever started it. You run them, read the verdict, and report it in a few lines. You do not edit the hook, `journal.ts` or any settings file, and you do not fix a failing drill: you name the missing fact.

## 1. Run them

```bash
node scripts/drills/cold-start-drill.ts
node scripts/drills/equivalence-drill.ts
node --test scripts/drills/drills.test.ts
```

Each drill builds a fictional ledger and vault in a temporary directory, runs the SessionStart hook in a subprocess with a clean environment, and removes the directory. Nothing outside the temporary directory is read or written. Each takes a few seconds.

## 2. Read the verdict

| Output | Meaning | You do |
|---|---|---|
| `... drill: ok`, exit 0 | Every fact is on the page. | Report ok. |
| `MISSING <kind> <id>`, exit 1 | The context lacks that fact. Kinds: `priority` (yesterday's priorities file or its item count), `open-id`, `ask`, `how-to`. | Report the lines verbatim. Do not patch anything. |
| `MISSING <source>: id <id> named by another source only` | `compact`, `clear` and `startup` do not carry the same ids. | Report it. |
| `hook produced no context` | The hook failed or printed nothing; the last stderr line is shown. | Report it. |

In `drills.test.ts`, two tests are TODOs and are expected to be listed as such, not as failures:

- the crash drill (epic done point 3) needs R3, the session marker and recovery, and cannot run until it exists;
- yesterday's priority text is not printed on the cold-start page, which cites the priorities file and counts its items; the test records that gap and starts passing when the page prints the lines.

## 3. What the facts are

The facts come from the fixture written by `scripts/drills/lib.ts`: yesterday's priorities file path and its item count, the ids of the open, blocked and queued items, the pending ask (id and text), and the library pages that point at how each active stream is worked. The cold-start drill reduces the ledger to its live rows first; the equivalence drill uses the full ledger.

## 4. Report

One line per drill: ok or the missing facts, plus the count of TODO tests. Fictional names only.

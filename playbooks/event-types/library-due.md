# Event type: library-due

Reports when learned rows, or misses (questions the library could not answer), are waiting for the composer. Script: [scripts/event-types/library-due.ts](../../scripts/event-types/library-due.ts). Target is the status directory (any existing directory; the ledger is found from the configured project). One watch.

Register: `node scripts/event-loop.ts add --id library-due --type library-due --target <status dir>`. It checks every 60 seconds, renews itself like the other standing watches, and does not notify unless added with `--notify`.

## What it watches

A learned row, and a `miss` row, is waiting until a `curated` row closes it (the closing fold is the cursor; there is no cursor file). The two are counted apart and together make up the waiting rows. The loop reads the ledger only when its file changes. A batch is due when no composer pass holds the `library:composer` lease, at least one row is waiting, and one of these holds: the ledger has been quiet for 10 minutes and the last pass began 30 or more minutes ago; 8 or more rows are waiting; or a `rolled` row is newer than both the last pass and the oldest waiting row.

It speaks once per batch. It stays silent until a new pass begins (a new lease row on the composer item). If no pass began within 2 hours it speaks once more. Curated rows and lease rows never raise the pending count, so a composer pass cannot wake itself.

## What the loop reports

| Digest line | Actionable | What to report |
|---|---|---|
| `library-due: N learned to compose (repo n, ...), oldest 2h` | yes | The line as it is. |
| `library-due: N learned to compose (repo n, ...), M misses to answer (T topics), oldest 2h` | yes | The line as it is; the misses part appears only when there are open misses. |

## What you do

Report the line and stop. You never compose, never run `library-write`, and never edit a page: the orchestrator dispatches the composer agent ([playbooks/composer.md](../composer.md), Sonnet), which takes the lock itself.

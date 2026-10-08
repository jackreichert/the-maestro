# Stop conditions

Read this before ending a Bolero run. The loop stops only when completely blocked ([SKILL.md](SKILL.md#stopping)). Run the checks in order; the first one that fails means keep going.

## Is anything still able to move?

- Is any item in the queue live, unblocked and not yet dispatched? (`journal.ts priorities show`, read fresh, then the [liveness check](../reference/dispatch.md#pre-dispatch-liveness-check).)
- Is any finished branch not yet merged on the integration branch and tested?
- Is any lane waiting only on a notification that has not arrived? That is not a block: end the turn and let it arrive.
- Is any item blocked only because the work is large? Split it ([PR size budget](../reference/git.md#pr-size-budget)) and dispatch the slices.
- Is the review queue over its cap? Then new PR-producing work is held, but fixes to open PRs and read-only work still go ([reference/dispatch.md](../reference/dispatch.md#review-queue-cap)).

If any answer is yes, the loop is not stopped.

## A legitimate block is one of these

| Kind | Test | What to bring |
|---|---|---|
| A decision only the user can make | Choosing wrongly is costly or hard to undo, and nothing in the code, docs or rules answers it | The options, a recommendation, and what each one unlocks |
| Failing tests that cannot be explained | A root-cause pass (earliest failing step, not a patch) found no cause; the failure is not already on the base branch | The command, the failing test names, what was ruled out |
| An external dependency | An access, allowlist, credential, review or other person's change that nobody in the session can supply | Who or what is needed, and what is waiting on it |

Before calling a credential missing, look it up by name with the env lookup helper; never open the file it names.

## When a block holds

1. Ask once, with the stakes: what is blocked, what each answer unlocks, what you recommend.
2. Park the item so the board shows what it waits for (an `ask` for a user decision; `log --kind blocked` for an external block, with `--gate` only for a PR merge, a date or a ticket closing), and keep every lane that does not depend on it going.
3. Say in one line what is still moving and what comes next.
4. If every lane is blocked, the loop stops here. Write the lanes plan's Blocked table into the ledger so the next session resumes from it.

## Not reasons to stop

- A tired session. Roll instead ([cost/budget.md](../cost/budget.md#session-hygiene)): finish relays, then run the roll, and the fresh session resumes the queue.
- A failure already on the base branch. Report it separately and ticket it; the lanes keep going unless it makes validation unreliable, and the suite is never skipped to get around it.
- A question the code, the docs or the rules already answer.
- An incidental finding. File it as its own ticket and carry on.

# Definition of Ready and Definition of Done

Read this when you write a brief for work that will close a ticket, or before you close one. A per-ticket "what done looks like" says what this ticket is for; this page is the shared minimum under it, so that done means verified, not just merged. The idea is Scrum's Definition of Done: work that does not meet it is not done ([Scrum Guide](https://scrumguides.org/scrum-guide.html)). The Guide has no Definition of Ready; the ready line below is our own addition, kept to four items so it stays a gate and not a form.

## Ready line (before dispatch)

Dispatch only when the brief names all four. A missing one is a question to settle first, not something the agent guesses.

| Item | What it names |
|---|---|
| Acceptance | The ticket's "what done looks like", in checkable words |
| Data source | Where inputs come from, or that none are needed |
| Deadline | The date it gates, or "none" |
| Review owner | Who reviews it, or that it is self-reviewed |

## Done block (before close)

Close a ticket only when each line is true and the report says how it is known. A line that does not apply says "n/a" and why.

| Line | Evidence to report |
|---|---|
| Tests exist and ran | The command and its actual result |
| Verified against a named check | The local or staging check by name, not "works" |
| Rollback or revert noted | The one-line way back |
| Tracker status moved | The status it now holds |
| Follow-ups ticketed | The ids of each, or "none found" |

An agent's "done" is a claim, and a claim is accepted only with the proof that fits it. A report, a confident tone or an earlier run is never the proof.

| Claim | Proof that counts | Does not count |
|---|---|---|
| "I changed X" / "it succeeded" | The VCS diff or sha for the change, read by the checker | The agent's summary of what it did |
| "Tests pass" | The command's output on this head, with its result line | A report of passing, or a run on an earlier commit |
| "Types and lint are clean" | The `tsc` or linter command's own output on this head | "Tests pass" (a passing suite is not a build) |
| "Fixed" | The original failing check re-run on this head and now passing | The code reading as right |
| "PR is ready" | `pr-state.ts` printing `READY-FOR-REVIEW: yes` now | A comment count or a memory of an earlier state |
| "Pushed" | The remote branch listing showing the sha | The push command exiting 0 earlier |

A claim with no row here gets the nearest row's standard: the checker names what would prove it and looks at that.

A ticket reopened for a missing line here is a defect in the brief or the close, not in the work: fix the page or the habit, then reopen.

Source: the Scrum Guide's Definition of Done, linked above; the checklist shape follows the guide's rule that every increment meets one shared standard. The Guide is the only external source; the five lines are our choice of minimum.

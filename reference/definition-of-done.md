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

A ticket reopened for a missing line here is a defect in the brief or the close, not in the work: fix the page or the habit, then reopen.

Source: the Scrum Guide's Definition of Done, linked above; the checklist shape follows the guide's rule that every increment meets one shared standard. The Guide is the only external source; the five lines are our choice of minimum.

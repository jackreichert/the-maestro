# One RAID page per deadline

Read this when a hard external date drives several streams, or when risks, assumptions and blockers for one date are scattered across checklists and handoffs. RAID is the technical-program-manager habit of one register of Risks, Assumptions, Issues and Dependencies, reviewed on a fixed rhythm ([role overview](https://www.devopsschool.com/blog/technical-program-manager-role-blueprint-responsibilities-skills-kpis-and-career-path/), a secondary source). Keep one page per deadline, not one per stream, so slippage on a gate is visible in one place.

## The page

One note per deadline, with four tables. Every row carries an owner, a date and the gate it blocks. A row with no gate is not part of this page.

| Table | A row says | Leaves the table when |
|---|---|---|
| Risks | Something that may go wrong, and how likely | It happens (it becomes an issue) or is ruled out |
| Assumptions | Something taken as true but not checked | It is verified (a fact) or found false (a risk or issue) |
| Issues | Something already wrong | It is fixed, with the evidence |
| Dependencies | Something outside our control that a gate waits on | It lands, or the gate moves |

## Keeping it small

- Seed it once from blocked ledger items, go-live checklists and handoffs, then link each row back to its source instead of copying text.
- Link the page from the status page so it is one click away.
- Review it weekly and time the review. Under ten minutes is the target; over that, the page has grown past what it is for, so merge or drop rows.
- Convert at least one assumption to a fact or a risk before the date. An assumption list that never shrinks is not being tested.
- It lives in the notes folder, not the tracker. A frozen or client-visible tracker label is respected: this page never writes to it.

Source: the role overview above. The four tables and the under-ten-minute test are our own settings.

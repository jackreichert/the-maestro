# Playbook: the project handover eval (for a cheap runner)

You check that one project tab of the Podium is enough for a new engineer. You answer six questions from that tab only, then a grader (a different agent) scores you. Run it after `node scripts/podium-gate.ts` shows the `handover` criterion passing, once per active project.

## Rules for the runner

- Read only the tab for one project: `GET /api/streams/<Stream>/home` (the `projects` entry for your project) and the text the Podium shows for it. Do not read the ledger, the vault by search, memory files or the repo, and do not ask anyone.
- Answer each question in one or two lines. Write `NOT ON THE TAB` when the tab does not say; never guess. A truthful `NOT ON THE TAB` is a result, not a failure of yours.
- Fictional names only in anything you write down; no secrets, no private text.

## The six questions

| # | Question | Where the payload answers it | Pass when |
|---|---|---|---|
| 1 | What is this project? | `overview.summary` | One sentence a stranger could repeat. |
| 2 | How do I run it locally? | `run` entries `setup` and `run` | Names the runbook pages, or says none is tagged. |
| 3 | How do I run its tests? | `run` entry `test` | Names the page, or says none is tagged. |
| 4 | What is blocked, and on whom? | `blocking` | Lists the blocked tickets with their reason, or says it is clear. |
| 5 | What was decided recently, and where? | `docs.decisions`, `docs.plans`, `docs.shared` | Names the decisions note, or says there is none. |
| 6 | What should I do next? | `overview.next`, `work.open` | Names the first next step or the top open ticket. |

## Grading

The grader marks each answer PASS, WRONG or MISSING against the `Pass when` column, with the vault open. The eval passes at 5 of 6 for each project. Record the score, each miss with a one-line reason, and the date in a dated review note. Every miss becomes a ticket or a library miss row: if the answer exists but the tab does not show it, that is a Podium gap; if the tab shows it and you missed it, tighten the `Where the payload answers it` column here.

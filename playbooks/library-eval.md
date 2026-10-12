# Playbook: the library eval (a Haiku runner, a Sonnet grader)

"Read the library first" is only worth saying if a fresh agent that follows it finds the answers. This eval measures that. The runner answers the ten questions using only the library; the grader scores the answers against the rubric. Run it after the composer has written or refreshed pages, and again at each weekly retro until it holds. The question list, the expected answers and the baseline of re-derived facts are in the vault note `Projects/the-maestro/Research/2026-10-08-library-eval-baseline.md` (Part 2); this playbook is the procedure, not a second copy of the questions.

## Who runs what

| Step | Model | Why |
|---|---|---|
| Runner: answer ten questions from the library | Haiku | A cheap reader is the right test: if Haiku finds it, anyone does |
| Grader: score each answer against the expected answer | Sonnet | Needs to judge "contains every must-have fact" and spot a contradicted fact |
| Disputed grade (runner and grader disagree on a must-have, or the expected answer itself looks out of date) | Opus, once | Settles it; the result goes in the report and, if the expected answer was wrong, in the baseline note |

## Rules for the runner

- Use only these sources, in this order, and write down each command or page you opened (the grader counts hops from this list):
  1. `node scripts/journal.ts find "<the question's key words>" --tickets-vault <vault root> --project <ledger project>` (add `--repo <repo>` when the question names one).
  2. The project's `INDEX.md` under `Projects/<repo>/`, for the page list and the component vocabulary.
  3. The library pages that `find` or the index name, and pages one link away from them (`find --neighbors`).
- Do not read the ledger, memory files, code, Plans, Research or Reviews, do not search the vault with grep, and do not ask anyone. A page that cites a source is enough: do not open the source.
- A hop is one `find` call or one page opened. Answer in at most three lines, name the page the answer came from, and give the hop count.
- Write `NOT IN THE LIBRARY` when the pages do not say. Never guess and never fill the gap from anywhere else. A truthful `NOT IN THE LIBRARY` is a result, not a failure of the runner: it names a page the composer still has to write.
- Quote ids and counts only; no secret values, no private text.

## Rules for the grader

For each question, read the runner's answer and the expected answer (and its rubric line) from the baseline note, then mark one of:

- `pass`: every must-have fact present, the source page named, 2 hops or fewer, nobody asked.
- `partial`: the right page was found but a must-have is missing, or it took 3 or more hops. Counts as a fail in the score; kept separate so the gap is visible.
- `fail`: a must-have is contradicted, or the answer is `NOT IN THE LIBRARY`, or the runner left the allowed sources.
- `ungraded`: the question's expected answer is itself unverified or marked provisional in the baseline note, so neither a pass nor a fail would mean anything. Ungraded questions come out of the denominator, and the report says so.

Score is passes out of graded questions; the target is 8 of 10 passes at 2 hops or fewer. Record, per question, the grade, the hops, the page, and for each non-pass the single thing missing (a page to write, a fact to add, a stale page to refresh): that list is the composer's next work.

## Where the result goes

A dated review note under `Projects/the-maestro/Reviews/` (frontmatter `ticket: the-maestro-121`), holding the score, the per-question table and the missing-pages list. Then, in the library plan note, one line with the date and the score. The go or no-go on Bayada and Options follows the plan's success metrics: a pass is 8 of 10, and the re-derived-fact rate against the baseline needs two weeks of data, so a first run can say "pages exist and are findable" but not "the rate fell".

## Re-verify before you run

The baseline's open items apply every run: check that each expected answer's source still says that (a moved env store, a changed hook, a develop branch that moved on) and mark a question `ungraded` rather than grade it against a stale answer.

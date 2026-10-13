# Playbook: the library composer (for a Sonnet runner)

You are the composer. You turn facts that have been established into library pages (`reference/library.md`) so the next agent reads the answer instead of re-deriving it. You are the only writer of `Knowledge/` and `Runbooks/` pages, and you write them only through `scripts/library-write.ts`, never with Write or Edit; `INDEX.md` stays with `library-index.ts`. The ledger is a source of claims, not of facts: a page holds only what you re-checked against code, a spec or a vault note you opened yourself.

## Inputs

- The facts to compose: `learned` rows and open `miss` rows (see Misses below), or (until those exist) the list your brief gives you, each with its claim, evidence and where it applies.
- The vault root, and the repo and stream the pages belong to.

## 1. Route

For each fact, find its page before writing anything: list `Projects/<repo>/Knowledge` and `Runbooks` and read `INDEX.md` for the repo's component list. One topic is one page. Same fact already on a page: refresh `verified-at` and stop. No page: make one from the template in `reference/library.md`. A component the list does not have is added to `INDEX.md` first, on purpose, with a name that matches the repo's existing style.

## 2. Verify before you write

Open the evidence yourself and record what you saw, not what the claim said.

- Code: read the file and line at the repo's current `origin` head and put the sha in `verified-at` (`2026-10-08@abc1234`).
- A spec, a decision, a vault note: open it and cite the path and line.
- A claim you cannot verify, or two sources that disagree: do not write it as current. Trust DECISIONS.md and the code over a ledger row, and say which source won in History. Anything still unclear goes back to the orchestrator as a question naming both sources.
- A fact a person stated and nothing else backs: write it with `told-by-jack` in its evidence text, and change it only on another statement from him.

## 3. Write, merge, supersede

Take the lock first: `node scripts/library-write.ts begin` prints your holder id (exit 3 means another pass holds it: stop and report). Draft each page in a scratch file outside the vault, then `node scripts/library-write.ts write <Projects/repo/Knowledge/page.md> --from <scratch file> --holder <id>`. It refuses (exit 1, nothing written) when a library rule, the secret scan or the comment-split check fails; fix the text and run it again. Close each fact you handled with `library-write.ts curate <learned id> --page <page> --holder <id> --model <m> --used <a,b>`, or `--reject "<why>"` for a fact you did not write. `curate --page` refuses (exit 1, nothing written) unless the page on disk is what your last `write` left, so a hand edit cannot be recorded as your output. When the fact is already on the page and you have nothing to change, curate it plain: that works while the page is still what your last `write` left. When that plain curate is refused, the page was hand-edited: never bless it (do not stage the disk copy and `write` it back, which is refused too, and never pass `--accept-hand-edit` in a pass). Close the learned row with `--reject "already on the page by hand edit"`, or raise a needs-you note, as step 6 of section 4b does. `library-write.ts end --holder <id>` when you are done.

- Claim first, present tense, one line per fact, ending `(verified YYYY-MM-DD, <evidence>)`.
- A changed fact replaces the old line in place; the old value goes to `## History` with its date and why. Never append.
- A decision is a pointer to DECISIONS.md or the plan that holds it. A status ("PR merged") is not a fact; reject it and say why.
- Name a secret by its variable name only. Never write a value, a connection string with credentials, a name, a date of birth or any contact detail. Systems, ids and counts only.
- Fill `composed-by` with `composer`, `stream` with the stream whose tab should list the page, and `ticket: none` unless the work belongs to a ticket.

## 4. Check

```bash
node scripts/library-check.ts --vault <vault root> [--repo <repo>]
node scripts/journal.ts notes-check --all
```

`library-check` must exit 0. `library-write` has already applied these rules to every page it wrote; the run confirms the pages on disk. A hand edit of a page is not prevented, only seen. Every finding is yours to fix; do not weaken a page to pass (a fact with no evidence is removed, not given a vague one). `notes-check` must list none of your pages: a page it names has no `stream:` or names an unknown one. Report both exit codes. If either fails twice for the same reason, stop and report it.

## 4b. Refresh stale pages

Do this when the orchestrator asks for a refresh, or when `library-fresh` reports stale pages. It needs no learned rows. A page is stale when a file its facts cite changed in git after the page's `verified-at`; it is not known to be wrong, only unchecked since.

1. List them: `node scripts/library-check.ts --stale --vault <vault root> --repo <repo> --code-root <folder holding the repo checkout>`. It prints each stale page with the file that changed. It always exits 0. Pages marked `unchecked` could not be looked at (no checkout, or no evidence file): list them in your report, do not touch them.
2. Work one stale page at a time. Read the page, then open every file its facts cite, at the checkout's current head, and re-read the lines each fact rests on. Run it inside the repo checkout under the code root. Take the sha after the `@` in `verified-at` and use `git log -p <sha>..HEAD -- <file>`; when `verified-at` is a bare date with no sha, use `git log -p --since=<date> -- <file>` (a bare date is not a revision, so `<date>..HEAD` fails with `bad revision`).
3. For each fact, decide one of three things.
   - Still true: keep the line and move its date forward. If the line numbers moved, fix them to where the text is now.
   - No longer true: change the line to what the evidence says now, and put the old value in `## History` with its date and why (section 3).
   - You cannot tell, or the cited file is gone: do not keep it as current. Remove the line and say in History that it could not be verified, naming the file. Never leave a fact you did not re-read.
4. When every fact is done, set `verified-at` to today's date and the checkout's head sha (`<date>@<sha>`), and keep the `verify-how` text true.
5. Write the page with `library-write.ts` exactly as in section 3 (begin, write, end). There are no pending learned rows, but record the new sha so step 6 has a current baseline next time: after each `write`, run `library-write.ts curate <learned id> --page <page> --refresh --holder <id> --model <m> --used <a,b>`, where the id is the `closes` of the page's earlier `curated` row (a refresh re-records a page that learned row already composed; it is refused otherwise). The command refuses a page whose bytes are not what your last `write` left, so it cannot record a hand edit; do not pass `--accept-hand-edit` in a pass. A page with no earlier `curated` row has no id to refresh and is left unrecorded. If `curate --refresh` is refused because the page has no write record (a page written before the guard existed), run `library-write.ts seed --holder <id>` once inside the pass, then retry the refresh. If the page is still unrecorded after `seed` (it is listed as left unrecorded), it was hand-edited: raise a needs-you note as in step 6 and do not bless it with `--accept-hand-edit`.
6. Never overwrite a human edit you disagree with. Before you write a page, compare it with what the last `library-write write` left: the sha256 of the page on disk (`shasum -a 256 <page>`) against the `pageSha` on the page's latest `curated` row in the ledger (a refresh from step 5 adds one, so the latest row is the last write) (`write` prints the first 12 characters of the same sha). If they differ, a person has edited the page since: do not overwrite the page. A page with no `curated` row has no recorded sha to compare, so only its `told-by-jack` lines are protected; say so in your report. When a protected line, or a line in a page that differs, says something the source contradicts, leave it as it is and raise a needs-you note instead, naming the page, the line, both sources, and what you would change. Raising it is appending a question, not editing the ledger: `node scripts/journal.ts ask "<page path, the line, both sources>" --recommend "<what you would change>" --door two-way --searched "<the two sources you compared>" --model <your model> --used "tool:library-check"`. Skip that fact and carry on. A page you left a note on stays stale, and your report says so. Detecting a human edit is not automated yet: `library-check --human-edited` (MAESTRO-299) will do this comparison for you once it lands.
7. Run section 4 (`library-check` and `notes-check`), then run `--stale` again. Every page you refreshed must be gone from the list. Report any that is not.

## 4c. Retros: lessons agents hand back

Every briefed agent files an `agent-retro` before it closes (`journal.ts agent-retro`). The retro is the intake: lessons wait there until you place them, so nothing an agent learned depends on someone remembering it.

1. List them: `node scripts/library-write.ts retros [--json]`. It is read-only and needs no lock. Each line is a retro id, the item it came from, and its lessons tagged `code`, `jack` or `process`. A retro a retro review already closed is not listed, so a lesson is never composed twice.
2. Treat each lesson as a claim, not a fact. Route it (section 1), then verify it against code, a spec or a vault note you opened yourself (section 2). Evidence you cannot open means the lesson is not written as current. A `jack` lesson with nothing else behind it is written with `told-by-jack` in its evidence text.
3. A lesson that is a fact about how the project works becomes a line on its page or a new page (section 3), in plain language, with evidence cited. A one-off, a status, a binding working rule (the orchestrator records those, not you) or a lesson you cannot verify is not written; say why when you close the retro.
4. Close the retro with `library-write.ts curate <retro id> --page <page> --holder <id> --model <m> --used <a,b>` once its lessons are placed, or `--reject "<why>"` when none of them belongs in the library. One `curated` row closes one retro, so close it after the last page you wrote for it, and name in your report any other page it touched.
5. If a lesson contradicts a human edit or a `told-by-jack` line, do not overwrite it and do not revert it: raise the ask from section 4b step 6 with both sources, leave that lesson out, and carry on. The retro can still be closed once everything else is placed; the ask carries the disagreement.

## 5. Report

At most 12 lines: pages written, refreshed or changed with their paths, facts you could not verify, needs-you notes raised, facts rejected with a reason, questions you could not settle, and the two exit codes.

## Misses: questions the library could not answer

A `miss` row is a question someone asked and the library had no page for (a `journal.ts find` with no result, a `journal.ts ask --how-do-i`, or an eval partial logged with `journal.ts miss --source eval`). List the open ones with `node scripts/journal.ts misses` (add `--json` to parse it); a miss is open until a `curated` row closes it. Rows with the same `topic` are one question asked more than once: answer the group with one page.

For each topic, in the same pass and under the same lock as the facts:

1. Find the page that should answer it (section 1) and verify the answer from code, a spec or a vault note (section 2). A miss is a question, not a claim: write only what you verified.
2. Write or extend the page (section 3), then close every miss of the topic: `library-write.ts curate <miss id> --page <page> --holder <id> --model <m> --used <a,b>`. A closed miss names the page that answers it.
3. A question you cannot answer from evidence, or one that is not about the project (the weather, a one-off), is closed with `--reject "<why>"`, one plain line. Do not write a page to make a miss go away, and never close a miss without one of the two.

Report the misses answered (ids and page paths) and the ones closed out of scope with their reasons beside the facts.

## Hard rules

- Do not edit the ledger, DECISIONS.md, memory files or any code repository. Appending a row with `journal.ts ask --searched "<what you read>"` (section 4b, step 6) is not an edit: the ledger is append-only and you only add to it.
- Do not copy a ledger value you did not verify. A value that two sources disagree on is a question, not a fact.
- No secrets and no PHI in a page, in your report or in a question.
- Do not run `library-check` on a copy: run it on the real pages, and say so.

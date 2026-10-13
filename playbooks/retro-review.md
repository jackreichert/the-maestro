# Playbook: retro review (for a Sonnet runner)

You review the retros agents wrote before they handed back, and decide what each lesson becomes. The orchestrator dispatches you when a `retro-due` event says a batch is waiting ([event-types/retro-due.md](event-types/retro-due.md)), every few hours at most. A lesson that stays in a retro row helps nobody: your job is to move the ones worth keeping to the place the next agent reads, and to close every retro either way.

`J` below is `node <maestro scripts dir>/journal.ts --project <project>`.

## 1. Read the batch

`$J agent-retros --json` lists the retros waiting (`pending`, each with its item, stream and lessons) and the briefed items closed without one (`missing`, with the `--no-retro` reason when there is one). Work the whole list in one pass.

## 2. Decide each lesson

Check for a duplicate first: `$J find "<a few words of the lesson>"` for library pages, and the retro's own `--learned` links for facts the agent already recorded. A lesson already on a page or already recorded is closed as a duplicate, not promoted again.

| The lesson is | It becomes |
|---|---|
| A fact about the code with evidence you can check (a file and line, a command and its output) | A `learned` row: `$J learned "<claim>" --kind ... --applies-to ... --evidence ... --verified-at ... --confidence observed`. Open the evidence yourself first; the composer turns the row into a page later. |
| A `jack` lesson that binds how work is done from now on (a preference, a rule, a "never do X") | Do not record it yourself. List it for the orchestrator, which records it with `decide --scope working-rule` or as a rule, because only the orchestrator talks to the user and can confirm it. |
| A `process` lesson that names a gap in the tooling or the playbooks, seen in two or more retros | A ticket in the project's tracker, naming the retros that saw it. One retro alone is not enough: note it and wait for a second. |
| A one-off (specific to that item), already covered, or unverifiable | Nothing; say why in the note. |

Never copy a secret, a credential, a person's name or any patient data into a promotion, even if a lesson hints at one; the write commands scan for them and refuse, and a refusal means rewrite it as a system, an id or a count.

## 3. Close each one

For every retro and every missing item: `$J retro-reviewed <retro id | item id> --note "<what was done, in one line>" [--promoted learned:<id>,ticket:<id>]`. A missing item with a good reason (`agent was stopped`) is closed with a note; one with no reason or a weak one is listed for the orchestrator, since an agent skipped its retro.

## 4. Hand back

At most 8 lines: how many retros you closed, what each promotion became (with its id), the `jack` lessons waiting for the orchestrator to record, the process lessons you are watching for a second sighting, and any missing retro with no good reason. Nothing else.

# Playbook: commitments sweep before a roll (for a cheap runner)

You are the runner. Before a roll, you check that what the user said in this session, in their own words, that binds the future ("we decided", "before prod", "make sure", "from now on") is carried by the ledger or a standing pickup, so a fresh session still sees it. You sort each gap into one of four homes and write it there. You never invent a commitment: every line you write quotes or closely paraphrases the user's sentence and names its turn.

## 1. Run the sweep

```bash
node scripts/commitments-sweep.ts [--transcript <file.jsonl>] [--vault <ledger root> --project <name>]
```

With no `--transcript` it reads the newest session in `projects_dir`, the same one the footer's Session line measures. It reads only the user's typed messages (not tool results, reminders, task notifications or agent hand-backs), is read-only, and prints one row per candidate: the turn number, the verdict (MATCHED, CHECK or UNMATCHED), the cue class (`before prod`, `make sure`, ...) and the id of the nearest open ledger item or standing pickup by shared keywords. **It prints no typed text at all** (a sentence could hold a password); you read the turn yourself in the transcript file named on the first line. Find it by the `line` column: it is the line number of that file (`sed -n '<line>p' <file>` prints the one JSON record; its `message.content` is what the user typed, and a candidate is the sentence in it that carries the cue). `turn` is only the count of typed messages from 1. `--json` adds `uuid` and `ts` (the record's own `uuid` and `timestamp`, `null` when absent), which you can search the file for. A wrong `--vault` or `--project` exits 2 (`no ledger at ...`) instead of reporting everything UNMATCHED: fix the arguments, never file rows on the strength of it.

| Exit | Meaning | You do |
|---|---|---|
| 0 | No candidates, or every one is MATCHED with high confidence (the matched open item holds at least 60 percent of the sentence's words). | Read each MATCHED row's turn in the transcript and its item with `journal.ts status` (see "Read every row" below); report `commitments: clean` only if they all hold. |
| 1 | At least one UNMATCHED: no open item comes close. | Step 2. |
| 3 | No UNMATCHED, but at least one CHECK: an open item shares words with the sentence but covers too little of it. | Read the row's item, then decide as for UNMATCHED if it means something else (step 2), or accept it and say why. |
| 2 | Usage or read error (no transcript, no ledger at that vault and project, bad flag, ledger root unset). | Report the stderr line. Fix the arguments once; if it fails again, stop. |

Matching is by keywords only, and only against open ledger items, rules filed with `journal.ts rule` (a decision row with a `--ref` file) and live standing pickups; a finished item never matches. A MATCHED row means the board mentions those words, not that the commitment is captured. **Read every row.** For each MATCHED and CHECK row, read the turn in the transcript and the carrying item (`journal.ts status`, or `standing list` for a standing id), and compare their meaning. If the item is about something else (another tenant, another stage, a different action), treat the row as UNMATCHED and handle it in step 2. Report which MATCHED and CHECK rows you accepted.

## 2. Decide each UNMATCHED candidate

Read the user's sentence at that turn in the transcript, with the sentences around it for context. Pick exactly one:

| What it is | Where it goes |
|---|---|
| A condition on a future action ("before prod, do X", "when Y merges, check Z"). | `node scripts/journal.ts standing add <id> --trigger "<the condition>" --action "<what to do>" --who "<who>" --every-hours N` |
| A lasting rule ("always stage by path", "from now on ..."). | Save it to a memory file first, then `node scripts/journal.ts rule "<rule>" --ref <memory-file>`. |
| A piece of work ("we need to figure out ..."). | `node scripts/journal.ts queue "<text>"` for a to-do, or `start` if it is running now. When it waits on something, `node scripts/journal.ts log "<text>" --kind blocked --gate gh:pr:<repo>#N\|date:YYYY-MM-DD\|ticket:<id>`. |
| Noise (a preference about this one reply, a quoted rule already stored, a question). | Skip it, and say why in the report. |

Rules of thumb:

- Use the user's words for `--trigger`, `--action` and the item text. Do not reword a decision into something stronger or weaker.
- `standing add` needs a cadence (`--every-hours N`) or a runtime `--check`; pick a cadence that matches how soon the trigger could fire (24 for "before prod" on an active project). `--who` is the role that acts (`orchestrator`, `any model (haiku)`), not a person's name.
- Each log or `standing add` needs the usual `--model` and `--used` flags and a stream the way `reference/ledger.md` says.
- A standing id is lowercase words joined by hyphens (`proxy-before-prod`); `standing add` refuses digits and punctuation.
- Check for an existing home first: `node scripts/journal.ts standing list` and `node scripts/journal.ts status`. If the commitment is already there under other words, record nothing and say which id carries it.
- Never put a secret, a customer name or a person's data in a row; paraphrase around it. If the turn contains anything that looks like a credential (a password, key, token, login pair or PIN), do not copy any of it into `standing add`, `rule`, `queue` or `log` text, do not quote it in your report or in a question; say "a credential was mentioned in turn N" and ask the user how to record the commitment.

## 3. Verify and report

Run the sweep again. Every row you wrote a home for should now read MATCHED (or CHECK, if you worded the item differently: read it and accept it); a row you skipped as noise stays UNMATCHED, and that is fine as long as the report says why. Report at most 12 lines: candidates found, then one line per UNMATCHED candidate with `turn N -> <home and id | skipped: reason>`.

## When to ask the user

Ask, in one short batch, instead of deciding, when:

- you cannot tell whether a sentence is a commitment or a passing remark;
- two homes fit (a rule that is also a condition on a launch);
- a standing pickup needs a trigger or cadence the user's words do not give;
- the turn is not in the transcript you were given.

Quote the user's sentence in the question and offer the two likeliest homes. Never guess.

## Failure handling

- Exit 2 with `no sessions`: pass `--transcript <file>` for the session in question, or report that `projects_dir` is unset.
- A `journal.ts` write refuses (bad `--ref`, a row with no check or cadence): fix the one argument it names and retry once; if it still refuses, report the refusal and leave that candidate for the user.
- An id printed as `[id withheld]` is a hand-edited ledger id or an older standing id with digits or punctuation: look it up with `journal.ts status` or `standing list` by what it says, and do not copy it.

## Hard rules

- Do not write a commitment the user did not state. Do not close, resolve or retire anything.
- Do not send, post or message anything; the sweep and this playbook stay local.
- Do not edit the ledger or `standing.jsonl` by hand; use `journal.ts`.
- Run it before `roll`, not after: a roll moves the day's lines into the archive.

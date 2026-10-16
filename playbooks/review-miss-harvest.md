# Playbook: review-miss harvest (for a cheap runner)

You are the runner. The harvest keeps what reviewers found that the author's own review missed, so mithril can learn from real evidence and the planning checklist can learn what the author should have looked for first. The script does the fetching, deduping and word-matching. You do the judgement: each finding's fate, whether it is a real miss, and which source backs a proposed rule. Every command is read-only against GitHub; the only writes are the local store, `triage` lines, and the weekly note.

| Step | Command | Writes |
|---|---|---|
| 1. Harvest | `node scripts/review-harvest.ts harvest <owner/repo#N>...` or `--since YYYY-MM-DD` | the local store |
| 2. List | `node scripts/review-harvest.ts pending --json` | nothing |
| 3. Triage | `node scripts/review-harvest.ts triage <id> ...` | one triage line |
| 4. Batch | `node scripts/review-harvest.ts batch --write` | one note in the mithril Research folder |

## 1. Harvest

After a merge, name the merged PR. On the weekly pass, use the week's start so a PR no hook saw is still read: `node scripts/review-harvest.ts harvest --since <7 days ago>`. Only PRs authored by the configured `gh_login` are read; others are listed as skipped. Running it twice changes nothing. If a PR is unreadable the exit is 2 and the line says why: report it and go on.

## 2. List

`pending --json` gives each untriaged finding: `id`, `kind` (copilot, aikido, human), `path`, `gist`, `prs` (twin copies listed once), `threads`, `fate` (a hint from the thread state and Jack's reply), `hints`, and `coverage` (up to two skill lines that share words with the finding).

## 3. Triage

Decide per finding, then run `triage`. Work from the gist and the hints; open the thread only when the gist cannot decide it.

1. **Class.**
   - `dropped` when it is not a real miss: a false positive, code the PR did not change (hint `pre-existing`), something CI catches by failing (hint `ci`), or a declined style nit. Say which in `--why`.
   - `planning` when the author could have avoided it by looking before building: a helper `core` already has, how a sibling EMR or scraper does the same thing, a duplicate of existing code. Hint `planning` suggests it; confirm it. `--candidate` names the prior art that existed, in a few words. These do not go to mithril.
   - `mithril` otherwise: a real defect a code reviewer should have caught in the diff.
2. **Fate** (`--fate`): fixed, deferred, declined, resolved, or open. Start from the hint and change it only on evidence.
3. **For `mithril` only:** `--coverage covered|partial|not-covered`, judged from the `coverage` lines. Covered means a rule already names it, so the miss is a recall problem, not a text problem: leave out `--candidate`. `--category` is a short noun phrase; reuse an earlier one when it fits.
4. **For `partial` and `not-covered`:** `--skill <name>` and a one-sentence `--candidate` that sharpens an existing rule rather than adding one. `--cite` is a short id and section from mithril's `Resources/` (see the citation index in its `Resources/README.md`); if you cannot find one there, pass `--cite unsourced`. Never invent a source. An unsourced candidate is shown as blocked until Jack approves a library addition.

`--real yes|no` is required. Stored gists can still carry a customer, a person or a display value that the scan cannot see. Whenever one does, pass `--gist "<your rewrite, code-level words only, under 160 characters>"`: the note shows it in place of the stored text. The `File` column shows file names as stored, so read it too: a name can carry a customer or EMR. The same goes for any gist that is a bot's report (a plan summary, a scan table) rather than a finding: drop those.

```bash
node scripts/review-harvest.ts triage <id> --class mithril --real yes --fate fixed --coverage partial --skill code-quality --cite CC2-8 --category "Empty input read as safe" --candidate "<sharpened rule text>"
node scripts/review-harvest.ts triage <id> --class planning --real yes --candidate "core already has a shared retry helper"
node scripts/review-harvest.ts triage <id> --class dropped --real no --why "CI catches it"
```

## 4. Batch

When nothing is pending and no note exists for this week, run `node scripts/review-harvest.ts batch --write` (a preview without `--write`). It writes `<until>-copilot-findings-batch-<n>.md` to the mithril Research folder and refuses to overwrite. A week with untriaged findings is not written; finish step 3 first.

## Report

At most 8 lines: how many PRs harvested, new findings, triaged by class (mithril, planning, dropped), the note path if written, and anything unreadable or unsourced. No raw JSON.

## Hard rules

- Never edit a mithril skill, `Resources/`, or the planning checklist. Candidates are proposals in the note; Jack approves them.
- Never comment on, resolve, or reply to a PR thread. Never run `gh` yourself: the script reads GitHub.
- Never put a person's name, a customer, a display field, or a credential into `--why`, `--candidate`, `--category` or `--gist`.
- Any recursive `grep` or `rg` carries `--exclude='.env*' --exclude='ssm-*.json'`, and you never open those files.

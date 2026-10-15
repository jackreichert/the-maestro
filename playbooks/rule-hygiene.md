# Playbook: rule hygiene (for a cheap runner)

You are the runner. You list which memory rules do not say what enforces them and which rules the user had to repeat. You change nothing: memory edits, pruning and promotion are the user's decision, made in one batch.

## 1. Run the check

```bash
node scripts/rule-hygiene.ts --memory-dir <memory folder> [--audit <repeated-instructions audit.md>]
```

It is read-only and prints no rule text. Lines: `MISSING <rule>` (no `enforced-by` value), `INVALID <rule>` (not one of `hook`, `script: <path>`, `check`, `none`), and with `--audit`, `PROMOTE <rule>` for a rule the audit's repeated-instruction table cites that is enforced by `none` or by nothing.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Every rule is tagged and no repeated rule is unenforced. | Report `rules: clean`. |
| 1 | Some rule is untagged or invalid, or a repeated rule is unenforced. | Step 2. |
| 2 | Usage or read error (no folder, no audit file, bad flag). | Report the stderr line. Fix the argument once; if it fails again, stop. |

## 2. Report one batch

Report at most 12 lines: the counts, then the PROMOTE rules (each is a candidate for a hook, script or check), then how many are MISSING. Do not list every missing rule. A rule appearing in the audit means the user repeated that topic, not that the rule is broken; say so.

## Hard rules

- Do not edit, delete or rewrite any memory file. Propose in the report; the user approves.
- Do not send or post anything; this stays local.

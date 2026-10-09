# Playbook: read a PR's real review and merge state (for a cheap runner)

You are the runner. You run one script, then copy its lines into your report. You do not interpret, summarise or soften them, and you do not fix, comment, resolve, approve or merge anything.

## When to run it

- Before any push to a PR branch.
- Before saying a PR is ready.
- Before telling Jack a merge order.

An empty `reviewDecision` is not proof that no approval exists: a push can dismiss an approval and leave the field empty. Never answer these questions from `gh pr view` alone.

## 1. Run it

```bash
node <scripts_dir>/pr-state.ts <owner/repo#N | PR URL> [more PRs...]
```

It is read-only and needs `gh` logged in. Add `--json` only if the orchestrator asks for machine output. Run it in the foreground; it makes one call per PR.

| Exit | Meaning | You do |
|---|---|---|
| 0 | Every PR was read. | Step 2. |
| 2 | Bad arguments, or a PR could not be read (the output says which). | Report the `could not read` line. Fix a typo in the argument once; if it fails again, stop. |

## 2. Report back

Copy these lines verbatim, per PR, in this order, and add nothing in between:

1. the first line (PR, head sha, base, draft)
2. every `reviewer ...` line
3. the `unresolved human threads` and `unresolved bot threads` lines, with their thread lines
4. the `checks:` line
5. the `PUSH WARNING:` line, if there is one
6. the `READY-FOR-REVIEW:` line
7. the `READY-TO-MERGE:` line

If a `PUSH WARNING` line is present, say so first in your report and do not push unless the orchestrator's brief says to push anyway.

## Hard rules

- Do not paraphrase a verdict word. `APPROVED-stale`, `DISMISSED` and `APPROVED-on-head` mean different things.
- Do not call a PR ready for review unless `READY-FOR-REVIEW:` says `yes`, and do not call it mergeable or ready to merge unless `READY-TO-MERGE:` says `yes`. Quote the reasons in the parentheses as written.
- Do not paste raw JSON or logs.

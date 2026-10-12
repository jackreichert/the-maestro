# Playbook: sort memory into project facts and working rules (for a Haiku runner)

You are the runner. Memory is for how to work with the user; project facts belong on library pages. You produce the split for the user to answer in one batch. You never edit, move or delete a memory file, and you never write a library page: the composer does that, after the user answers.

## 1. Sort

```bash
node scripts/memory-sort.ts --memory-dir <memory dir>
```

Read-only; one row per file with a verdict (`project-fact`, `behaviour-rule`, `decision-or-status`, `unsure`), a target page and the reason. It prints no file body. Exit 2 means a usage error: fix the path once, else stop and report.

## 2. Check the dry run

```bash
node scripts/memory-migrate.ts --memory-dir <memory dir> --vault <vault root> [--approved <file>]
```

Dry run. Each project fact shows `wait-for-page`, `wait-for-approval` or `point`. Never pass `--apply` unless the user has given you the approved list in this session; with it, only `point` files change, to a one-line pointer.

## 3. Report

At most 12 lines: the counts, the `unsure` and `decision-or-status` names (the user decides these), and the project facts grouped by target project. Name no file body text. Nothing moves until the user answers the batch; then the composer (`playbooks/composer.md`) writes each approved fact's page with evidence and `verified-at`, then you run step 2 with the approved list, then step 2 again with `--apply`.

## Hard rules

- No edit to a memory file without `--apply` and the user's approved list.
- No library page written by you; no secrets or PHI in the report.

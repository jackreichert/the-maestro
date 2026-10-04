# Event type: pr-watch

Review activity on the user's open PRs. Script: [scripts/event-types/pr-watch.ts](../../scripts/event-types/pr-watch.ts). The loop keeps the PR snapshot in its own state file and diffs each check against it, so the snapshot and the digest are saved together.

Register: `node scripts/event-loop.ts add --id reviews --type pr-watch --target open-prs --report "<what to tell the orchestrator>"`. A watch lives 72 hours (the loop default for other types is 24); re-register it when it expires, with `--ttl-hours` to change that. Only one `pr-watch` watch may exist (`add` refuses a second, also under the old name `pr-review`). The PR set is scoped by local-config (`gh_org`, `gh_login`), not by the target. Use `--target open-prs:baseline` to record the first snapshot without reporting what is already there.

## What the loop reports

Every line is actionable.

| Digest line starts with | What to report |
|---|---|
| `THREAD`, `REPLY`, `COMMENT`, `REVIEW` | The PR key, who, and the link. Do not summarize the comment text. |
| `DECISION` | The PR and the move (for example into `APPROVED` or `CHANGES_REQUESTED`). |
| `LEFT-OPEN-SET` | The PR was merged or closed. |
| `APPROVED-UNMERGED` | An approved PR is waiting. Reported once per approval or moved head. |

A check also requests a Copilot review on draft PRs in scope that have none, only for owners in `copilot_orgs`.

## Do not

Reply to threads, resolve them or push fixes. Report the lines and stop.

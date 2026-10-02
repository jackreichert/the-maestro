# Event type: pr-review

Review activity on the user's open PRs. Script: [scripts/event-types/pr-review.mjs](../../scripts/event-types/pr-review.mjs), a wrapper over [scripts/pr-watch.mjs](../../scripts/pr-watch.mjs): it runs `pr-watch.mjs --once` with a state file of its own and turns each reported change into an event, so the rules for what counts as a change live in one place.

Register: `node scripts/event-loop.mjs add --id reviews --type pr-review --target open-prs --report "<what to tell the orchestrator>"`. The PR set is scoped by local-config (`gh_org`, `gh_login`), not by the target.

## What the loop reports

Every line is actionable.

| Digest line starts with | What to report |
|---|---|
| `THREAD`, `REPLY`, `COMMENT`, `REVIEW` | The PR key, who, and the link. Do not summarize the comment text. |
| `DECISION` | The PR and the move (for example into `APPROVED` or `CHANGES_REQUESTED`). |
| `LEFT-OPEN-SET` | The PR was merged or closed. |
| `APPROVED-UNMERGED` | An approved PR is waiting. Reported once per approval or moved head. |

pr-watch's other behaviour still applies: it requests a Copilot review on draft PRs in scope that have none.

## Do not

Reply to threads, resolve them or push fixes. Report the lines and stop.

# Event type: repost-nudge

Nudges the user to repost his PRs in Slack so they get reviewed. Script: [scripts/event-types/repost-nudge.ts](../../scripts/event-types/repost-nudge.ts), rules in [scripts/lib/repost-nudge.ts](../../scripts/lib/repost-nudge.ts). Target is the status directory (any existing directory). One watch; `session-start.ts` registers it.

Register: `node scripts/event-loop.ts add --id repost-nudge --type repost-nudge --target <status dir>`. It checks every 300 seconds (one GitHub search), renews itself like the other standing watches, and does not notify unless added with `--notify`. Off with `repost_nudge_minutes: 0`.

## What it watches

- **Approval trigger.** The newest APPROVED review on any of his open PRs (the same search scope as `pr-watch`). The nudge is due `repost_nudge_minutes` (60) after it.
- **Review trigger.** A teammate review draft queued or posted (a `review`-source row in `drafts.jsonl`, written by `teammate-review.ts submit` and by the Podium's Approve). Due at once.
- **Hours.** Weekdays from `repost_nudge_start` to `repost_nudge_end` in `repost_nudge_tz` (08:30 to 18:00 ET). A nudge due outside them is held, and one nudge goes when they open. At most one an hour.
- **Not after he asked himself.** No nudge within `repost_nudge_asked_minutes` (60) of a Slack line by him that links an owner's PR (from the notes `slack-watch` keeps) or a review re-request he made on GitHub of a person (Copilot, other bots and teams do not count). It is held and goes once the window has passed.
- **Which PRs.** Ready, `REVIEW_REQUIRED`, not conflicting, no unresolved thread, in a repo other people review, oldest-waiting first, at most `repost_nudge_count` (3). With none, the trigger is answered and dropped: nothing is held for later. Any approval on his open PRs starts the clock, whichever repo it is in.

The first check adopts approvals and drafts already there without a nudge.

## What the loop reports

| Digest line | Actionable | What to report |
|---|---|---|
| `repost-nudge: 60 min since the last approval; repost 3 PRs waiting longest (org/repo#12 340m, ...). Slack: "Could I get a review on these PRs? <links>"` | yes | Raise it as an ask for him, then relay the line. |
| `repost-nudge: a teammate review is queued; repost ...` | yes | Same. |

## What you do

Raise one ask so it shows under Needs-you on the Podium: `journal.ts ask "Repost your PRs in Slack?"` with the template, the PR links as `--link`, the Slack message from the line as a `--context`, `--outward` (another person sees it) and `--recommend "Post it now: they are waiting longest"`. Then report the line and stop. You never post the message: only he does.

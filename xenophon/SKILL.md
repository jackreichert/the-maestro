---
name: xenophon
description: "Use when creating, browsing, updating, closing, or pruning stale local project tickets, or preparing approved Jira issues."
disable-model-invocation: true
---

# Xenophon

One Markdown note per ticket in the configured vault is the source of truth; a ledger records activity, not intent. This standalone workflow requires file access, not another skill or helper. Rules guide the agent; they are not automated enforcement.

## File actionable work

- Track durable work, not routine questions or status checks; ask before filing incidental findings. Check active and archived tickets; update or reopen duplicates. Separate unrelated problems.
- Use [the template](./template.md): symptom/outcome title, problem/impact, observable **What done looks like**. Ask if unclear; never file `_TBD_`. Add scope, acceptance checks, decisions, and evidence; distinguish verified findings, hypotheses, and ruled-out causes.
- Size implementation leaves for one PR; develop/staging twins count as one. Split larger outcomes under parents into independently verifiable tasks; research or non-code work needs a bounded deliverable.

## Estimate

Estimate effort, complexity, and risk, not priority; times are guides, not promises.

| Points | Scope | Time guide |
|--------|---------------|------------|
| 1 | Tiny, understood, single-surface; minimal setup/dependencies, independent | 1-2 hours |
| 2 | Small, 2-3 places; known behavior, no blockers | Half-day |
| 3 | Medium feature/investigation; testing and discussion | One day |
| 5 | Broad impact; discuss first | 2-3 days |
| 8+ | Split; leaves stay 1-5 | N/A |

- Clarify requirements, dependencies, assumptions, and done/go-live criteria. Include coding, QA/edge cases, review, docs, deployment, and fixes.
- Round up for uncertainty, coordination, migrations, regression, flaky dependencies, iteration, monitoring/rollback, and multi-customer impact; allow for interruptions.
- Time-box major unknowns as a 1-2 point spike with a defined deliverable, then re-estimate. Record points/rationale in **Estimate**, log changed assumptions/scope, and calibrate against completed work.

## Local records

- Resolve vault and owning repo; ask if unknown. Active notes: `Projects/<repo>/Tickets/<id>.md`; closed: `Tickets/Archive/`; overview: `Tickets/_Index.md`.
- Replace template placeholders; remove unused optional sections. Allocate `<repo>-NNN` above the highest active or archived ID; never reuse IDs. Serialize project writes; never overwrite a colliding ticket.
- Preserve template YAML fields and unknown metadata. Dates: `YYYY-MM-DD`; absent values: `null`; lists: arrays. Status: `open|in-progress|blocked|closed`; type: `bug|task|feature|epic|chore`; priority: `0` critical to `4` backlog, normal `2`.
- Leave `reviewed: false`; only the user stamps a review date. Resolution: `completed|retired` when closed, otherwise `null`; older closures without evidence remain unclassified.
- Rebuild the index after writes/moves: ID/link, title, status, priority, parent, blockers, review state, pending decisions, and deferrals. Sort active work by priority then ID; separate archived work and completed/retired counts. Derive rollups from descendants, including blockers and known points; never treat them as stored truth.

## Browse and maintain

- Inspect notes, not just indexes. Distinguish active from exactly `open`; filter by status, labels, decisions, or review state. Show parent/children or descendant trees when requested.
- Ready means `open`, no unresolved decision/deferral, and every blocker `completed`. Retired or unclassified blockers need explicit reassessment; missing references are errors.
- Parents describe shared outcomes; blockers describe dependencies. Resolve IDs across projects in the same vault; reject self-links/cycles. Preserve prose and history; append dated **Log** updates and decision options, recommendation, stakes, and resolution.
- Complete only with checks, results, and evidence for every acceptance criterion and done state in **Resolution**. Keep parents open while descendants remain active unless the user approves a documented exception; retired children do not prove the parent's outcome.
- Closing stamps `closed`, sets status/resolution, and moves to `Archive/`. Reopening restores the active path, clears `closed`/`resolution`, and logs why without erasing evidence.
- Attribute supporting documents to the most specific ticket through a deduplicated `tickets` frontmatter list; preserve existing content. Discover an epic's documents through descendants. Keep one linked brief of outcome, state, blockers, decisions, and as-of date; revalidate when tickets or attributed documents change.

## Pruning

- Run on request or weekly project review, not every session. Flag 30 days without substantive progress/revalidation, abandoned in-progress work, old blockers, duplicates, or apparent completion. Use dated logs, then `created`; missing dates need review. Age never expires work.
- Recheck current code, requirements, and PRs; record evidence and uncertainty, not cosmetic timestamp updates. Propose **keep** with a next action, **defer** with reason/revisit date or trigger, **complete** with verified outcome, or **retire** as duplicate/superseded/unwanted. Log deferrals; retain active status and reassess when due.
- Present a batch table: ticket/link, last substantive update, evidence, action, rationale. Get approval before retiring; uncertainty stays active.
- Archive, never delete. Record retirement approval/reason/replacement in **Resolution**; retirement is not delivery. Reassess parents/dependents without silently removing blockers; refresh briefs/index. Log actions, preserve `reviewed`, and report applied/pending/failed changes.

## Jira

- Local first; check duplicates and get approval before Jira creation, rewrites, or transitions. Confirm project, type, parent, required fields, and estimate; map metadata explicitly.
- Publish only title/public sections above the template boundary, with essential reproduction and team-accessible references. Exclude frontmatter, private vault/ticket references, local paths, ledger IDs, sensitive data, credentials, and AI attribution.
- Read back the issue; store its key in `external` and browse URL in **Links**. Local, ledger, and Jira closure are separate; none implies QA/deployment.

## Verify and report

- Keep secrets and sensitive personal data out of local and public records; do not access secret files or follow links outside the intended vault when editing records.
- Read back writes and links. Report ID, title, priority, local file link, and Jira URL. Surface failures/partial state; check for successful Jira creation before retrying. Never commit/push without permission.

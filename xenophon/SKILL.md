---
name: xenophon
description: "Use when creating, browsing, updating, closing, or pruning stale local project tickets, or preparing approved Jira issues."
disable-model-invocation: true
---

# Xenophon

One vault Markdown note per ticket owns intent; ledger owns activity. Standalone file-based guidance, not automated enforcement or a helper dependency.

## File actionable work

- Track durable work, not routine questions/status; ask before filing incidental findings. Check active/archive for duplicates; update/reopen rather than duplicate. Separate unrelated problems.
- Use [the template](./template.md): symptom/outcome title, problem/impact, observable **What done looks like**, scope, acceptance criteria (ACs)/checks, decisions, evidence. Clarify before filing; no `_TBD_`. Distinguish verified findings, hypotheses, ruled-out causes.
- Implementation leaves fit one PR (develop/staging twins count once). Split larger parent outcomes into verifiable tasks; bound research/non-code deliverables.

## Estimate

Estimate effort/complexity/risk, not priority; times are guides, not promises.

| Points | Scope | Time guide |
|--------|---------------|------------|
| 1 | Tiny, understood, single-surface; minimal setup/dependencies, independent | 1-2 hours |
| 2 | Small, 2-3 places; known behavior, no blockers | Half-day |
| 3 | Medium feature/investigation; testing and discussion | One day |
| 5 | Broad impact; discuss first | 2-3 days |
| 8+ | Split; leaves stay 1-5 | N/A |

- Clarify requirements, dependencies, assumptions, done/go-live criteria. Include coding, QA/edge cases, review, docs, deployment, fixes.
- Round up for uncertainty, coordination, migrations, regression, flaky dependencies, iteration, monitoring/rollback, multi-customer impact, interruptions.
- Time-box major unknowns as 1-2 point spikes with deliverables, then re-estimate. Record points/rationale in **Estimate**, log assumption/scope changes, calibrate against completed work.

## Local records

- Resolve vault/repo; ask if unknown. Active: `Projects/<repo>/Tickets/<id>.md`; closed: `Tickets/Archive/`; overview: `Tickets/_Index.md`.
- Replace placeholders; omit unused sections. Allocate `<repo>-NNN` above all active/archived IDs; never reuse. Serialize project writes; reject collisions.
- Preserve template YAML and unknown metadata. Dates `YYYY-MM-DD`; absent values `null`; lists arrays. Status `open|in-progress|blocked|closed`; type `bug|task|feature|epic|chore`; priority `0` critical to `4` backlog, default `2`.
- Keep `reviewed: false`; only the user stamps review dates. Closed resolution: `completed|retired`; otherwise `null`. Older unproven closures stay unclassified.
- Rebuild index after writes/moves: ID/link, title, status, priority, parent, blockers, review state, pending decisions, deferrals. Sort active by priority/ID; separate archives and completed/retired counts. Derive descendant rollups (blockers/known points), never store them as truth.

## Browse and maintain

- Inspect notes, not indexes alone. Active differs from exactly `open`; filter status/labels/decisions/review state. Show requested parent/child or descendant trees.
- Ready: `open`, no unresolved decision/deferral, all blockers `completed`. Reassess retired/unclassified blockers explicitly; missing references are errors.
- Parents share outcomes; blockers express dependencies. Resolve cross-project IDs within the vault; reject self-links/cycles. Preserve prose/history; append dated **Log** updates and decisions with options, recommendation, stakes, resolution.
- Complete only with **Resolution** checks/results/evidence for every AC and done state. Active descendants keep parents open unless the user approves a documented exception; retirement does not prove parent delivery.
- Close: stamp `closed`, set status/resolution, move to `Archive/`. Reopen: restore active path, clear `closed`/`resolution`, log why; preserve evidence.
- Attribute documents to the most specific ticket via deduplicated `tickets` metadata; preserve content. Find epic documents through descendants. Maintain one linked brief: outcome, state, blockers, decisions, as-of date; revalidate after ticket/document changes.

## Pruning

- On request/weekly review, not each session: flag 30 days without substantive progress/revalidation, abandoned work, old blockers, duplicates, apparent completion. Use dated logs then `created`; missing dates need review. Age never expires work.
- Recheck code/requirements/PRs; record evidence/uncertainty, not cosmetic dates. Propose **keep** + next action, **defer** + reason/revisit trigger/date, **complete** + verified outcome, or **retire** + duplicate/superseded/unwanted reason. Log deferrals; stay active and reassess when due.
- Batch table: ticket/link, last substantive update, evidence, action, rationale. Retirement requires approval; uncertainty stays active.
- Archive, never delete. **Resolution** records retirement approval/reason/replacement, not delivery. Reassess parents/dependents without silently removing blockers; refresh briefs/index. Log actions, preserve `reviewed`, report applied/pending/failed.

## Jira

- Local first; check duplicates and get approval for Jira creation/rewrites/transitions. Confirm project/type/parent/required fields/estimate; map metadata explicitly.
- Publish title/public sections above template boundary, essential reproduction, team-accessible references only. Exclude frontmatter, private vault/ticket links, local paths, ledger IDs, sensitive data, credentials, AI attribution.
- Read back; store key in `external`, URL in **Links**. Local/ledger/Jira closure are separate; none implies QA/deployment.

## Verify and report

- No secrets/sensitive personal data in local/public records. Don't access secret files or follow links outside the intended vault when editing records.
- Read back writes/links; report ID, title, priority, local link, Jira URL. Surface failures/partial state; check Jira creation before retrying. Commit/push requires permission.

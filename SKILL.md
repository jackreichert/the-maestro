---
name: the-maestro
description: Keeps multi-repo coding moving with delegation, durable memory, and visible priorities. Use when continuing work, dispatching agents, planning or implementing, handling branches and pull requests, or recovering after a fresh start or compaction.
---

# The Maestro

Keep work moving. Answer, then resume. Delegate work that needs its own context. Leave a record the next session can resume.

After you write code or prose, see if you can condense it without losing features, functionality, or clarity.

## Settings

Before path- or repo-dependent work, read [settings](./README.md#settings). Pass resolved paths, budgets, and branch flow in briefs. The CLI validates persistence settings. Budgets and branch flow guide the agent. They do not enforce Git.

## Follow-ups

Treat a new message as "continue, and also do this" unless the user pauses, stops, or switches. Clarify conflicts and unclear requests.

## Dispatch

1. **Choose.** Before the main thread does anything, run a complexity audit. Use the [delegation tree](./reference/delegation.md). The main thread keeps orchestration, judgment, and short answers. Hand off implementation, search, and long checks. No timer. Delegate substantial, self-contained work that gains from a separate context, independent judgment, or parallel progress, even if the parent could do it. Keep small tasks, continuous traces, tightly coupled edits, and unresolved user decisions in-thread. Reassess when scope changes. This choice needs neither user approval nor an agent every time.
2. **Recover and research.** Follow Memory. Search the library before code. For a substantial prior-art search across a repo, shared packages, or siblings, use a read-only scout. Return candidates, sources, contracts, differences, and search scope. "Not found" is not proof of absence. Keep a continuous trace in-thread.
3. **Plan.** Follow Craft. Set acceptance criteria, prior art, affected flow, risks, and verifiable pull-request slices. Use the user's configured models and agents. Save deeper planning for multi-system work, significant dependencies, design trade-offs, or hard-to-split work.
4. **Implement.** A configured fast agent does bounded research, routine implementation, and test triage. A configured deep agent does difficult debugging, architecture, and high-risk review. Follow the user's model preferences. Escalate unexpected complexity with findings. Work in-thread if no suitable agent is available. Brief as below.
5. **Prevent conflicts.** Parallelize independent tasks only. One writer per checkout. Use separate worktrees, or sequence edits.
6. **Stay non-blocking.** Run long tests and builds in the background. Agents investigate, implement, or review. They do not wait. Use completion notifications. Do not poll or start a duplicate run. Continue other authorized independent work. If background execution is unavailable, say so and run the checks.

### Briefs

Send repo or worktree, objective, acceptance criteria, scope, permissions, essential verified facts, safety constraints, file and symbol pointers, checks, and stop condition. Let the agent read the rest. Do not forward the conversation, whole files, or unrelated history. Add missing facts on request.

Ask for changed paths, concise findings, actual checks, blockers, and evidence pointers. Not raw logs.

Do not overlap agents or repeat their work in the parent. Reuse an agent only for the same task. Brief unrelated work fresh. Judge by useful results and avoided rework, not agent count.

### Long checks

Follow [validation discipline](./mithril/SKILL.md#verification-discipline). Confirm the process started, and [checkpoint the run](./ledger/SKILL.md#end-of-turn-checkpoint), before waiting or handing off. If no independent work remains, report the pending gate and yield. A checkpoint is not a test pass.

On notification, read the result once, save the outcome, and resume dependent work. Missing output or a lost process is unverified. Investigate before retry. Elapsed time is not a stall. Do not stop another task's process.

## Continuation

Reconcile on a fresh start, a new request, or a completion notification before the next pick.

Only the approved [session event loop](./reference/events.md) may monitor a selected wait. Do not poll with the model or a waiting agent. Finishing a turn persists prepared changes and may re-arm delivery. It does not acknowledge an event.

On a session event, read its local details, check ownership and relevance, and acknowledge before follow-up. Delivery is neither completion nor a memory receipt. Follow the [handling contract](./reference/events.md#trusted-handling-contract).

Before each pick, re-read Podium priorities. Check ticket and pull-request liveness, dependencies, gates, permissions, and ownership. After verified completion, advance only inside an authorized queue. Stop when exhausted, blocked, over budget, or out of scope. Rank is not permission.

After an interruption, follow [Podium recovery](./podium/SKILL.md). Relay verified outcomes, failures, and next actions. Do not duplicate live work.

## When to read a child skill

Read it before the work. Agents do not inherit it. Put the read in the brief. Reread the current phase after context loss.

| Work | Read |
|---|---|
| Tickets, incidental findings, Jira publication | [Xenophon](./xenophon/SKILL.md) |
| Shaping, delivery plans, technical designs | [Planning](./planning/SKILL.md). Store plans in the vault. Approved slices become tickets. A draft grants no implementation permission. |
| Coding checks | [Mithril](./mithril/SKILL.md), plus [planning](./mithril/reference/planning.md) or [after coding](./mithril/reference/after-coding.md). Load a runtime safeguard only when it applies. |
| Priorities, status, pull requests, questions, resume | [Podium](./podium/SKILL.md) |
| Decisions, checkpoints, topic recovery | [Ledger](./ledger/SKILL.md) |
| Reusable repo knowledge | [Library](./library/SKILL.md) |
| Pull-request writing, feedback, conflicts, readiness | [PR preparation](./pr-preparation/SKILL.md) and [PR writing](./reference/prs.md) |
| Retrospective, on request only | [Retro](./retro/SKILL.md). No scheduled run. |

## Memory

[Muninn](./README.md#muninn) is Ledger, Library, and Podium.

Tickets own intent. Podium owns priorities, streams, status, pull requests, gates, and resume pointers. Ledger owns decisions and checkpoints. Library owns reusable knowledge. Pass bead and page links in briefs.

On a fresh start or after compaction, read slim Podium, validate live ownership, then retrieve only the selected task's topic updates and library context. No second dashboard. No standing learnings.

Before finishing or compacting, follow [the checkpoint contract](./ledger/SKILL.md#end-of-turn-checkpoint). Save a high-value decision immediately. Do not ask the user to request routine memory updates. A requested write is not an acknowledgement. Do not capture raw transcripts or infer success.

## Acceptance criteria

Before coding, take acceptance criteria from the ticket or request: checkable outcomes, constraints, invariants, preserved behavior. Propose implicit criteria. Clarify material ambiguity. Do not invent scope.

Pair each criterion with a check. Include both in implementation and review briefs. Record clarifications on the existing ticket.

Verify every criterion, including cross-task outcomes. A task pass does not prove the whole outcome. Unmet or unverified criteria block completion. Only the user changes scope.

## Branch flow

Follow the repo's documented branch and release flow. Do not infer an environment from a branch name. Ask when guidance is missing or ambiguous.

Use `maintained-staging` only when the user or the repo confirmed it: `staging` → feature → `develop`, validate on the agreed test platform, then the same feature → `staging`. Release: `staging` → `release/yyyymmdd.x` → `main`. No direct `staging` → `main` deploy pull request. Confirm from guidance and release activity, not from branch existence or age.

This bundle grants no Git permission. Creating a branch, staging, committing, pushing, or rewriting history needs the user's explicit approval or a verified scoped standing grant. Record grants in Ledger, not shared settings. Do not inherit another installation's grants.

Before writing, check every commit since divergence against the user's confirmed author identity. Mixed authorship means shared. An empty branch is owned only when the user or an agent created it for the user. If uncertain, ask.

No direct writes to `main`, `staging`, `develop`, other protected branches, or shared branches. Do not rewrite another person's commits. Force-push only with specific permission, only on a verified user-owned unprotected feature branch that backs an open pull request, and only with an explicit expected-SHA `--force-with-lease`. Follow [PR preparation](./pr-preparation/SKILL.md#3-fix-conflicts-and-publish-safely). That permission does not allow reset, rebase, or merge.

Publishing a pull request needs permission. Drafts only. The user merges and promotes. After a commit or push, report the branch, changed files, and actual validation results.

No AI attribution in commits: no AI `Co-Authored-By`, and no "Generated with", "Created by", "Assisted by", or equivalent. Read the full message before committing and remove attribution a tool or template inserted. Keep the user's author and committer identity.

## Pull-request list

When asked for a list, use plain copyable lines: repository name, then one `<full PR URL> - <short description>` per line, and a blank line between repositories. Order by verified merge order. Flag unknown dependencies or cross-repo interleaving outside the list. No bullets, headings, tables, or other commentary inside the list unless asked.

## Pull-request size

Each slice must be safe to merge into its intended base: buildable, tested, backward-compatible where required, and usable if delivery stops. Prefer one complete feature, or one coherent aspect, including wiring, tests, and relevant docs. Do not leave broken intermediate behavior or need a later pull request to make the slice safe.

Aim for at most 500 changed code lines (adds + deletes) across at most 5 code files against the intended base. Up to 1,000 is acceptable when justified.

Exclude tests, config, and docs. Include migrations and SQL. Put lockfiles, generated or vendored files, and pure renames in separate mechanical pull requests. Those may carry tests, config, and docs.

Above 1,000 lines, stop and ask for an explicit per-pull-request override, or split at a complete behavior boundary. Smaller slices are welcome. Do not pad to 500. Dependencies must already be in the intended base. A passing stack is not enough. Configured limits cannot exceed 1,000. A wider file tier does not raise the line limit or waive mechanical separation.

## Craft

Default to the builder's review, not an agent per phase. Use independent review for substantial or risky changes: auth, data integrity, concurrency, public contracts, deployment. Return findings, evidence, and a suggested move, not a manual.

Non-trivial work: implement, review, fix, re-review, at most three rounds, self or independent. Fix in-scope blockers. Report the rest. Ask, with evidence, when a blocker repeats, the cap is exhausted, or scope grows. Blocked or capped is not done. Put this policy in the brief. Skip ceremony for trivial work.

## Communication

Lead with the answer. Add rationale, evidence, caveats, and next steps only when clarity or safety needs them.

For replies, code comments, and docs, write at about 80% of the way to ASD-STE100 Simplified Technical English. Use short sentences. Use active voice. Put one idea in each sentence. Use simple, common words. Explain a technical term the first time it appears. Give steps in order, one action per step. Use the same term for the same thing.

Keep a precise name, identifier, error, or requested wording when a simpler word would change the meaning. Do not add a comment that only restates a clear line. Expand when asked, or when uncertainty, risk, or a finding needs it.

Search first. Read the section that owns the method or contract. Return evidence, not raw logs. Batch routine completions. Report blockers, failures, and decisions as they happen.

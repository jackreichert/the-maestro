---
name: pr-preparation
description: "Use when preparing a PR, checking open PRs, addressing review comments, resolving feedback or conflicts, or checking merge readiness."
disable-model-invocation: true
---

# PR preparation

Prepare draft PRs and reconcile open ones; never merge or mark ready for review. Follow [branch ownership and size limits](../SKILL.md#branch-flow) and [PR writing guidance](../reference/prs.md). Prefer `gh`. This is an on-request workflow, not a poller. Optional [session events](../reference/events.md) notify about selected PRs but never replace this review or grant permission to act on feedback.

## 1. Establish scope and evidence

- Use the requested repos/PRs; otherwise use the user's open PRs in the active repo. Clarify ambiguous multi-repo scope. A request to "check open PRs" includes the feedback workflow below, not just a status summary.
- Verify repository, open state, head/base branches and SHAs, branch ownership, draft state, checks, reviews/approval SHAs, mergeability, and dependencies/twins. Read the complete base-to-head diff and repo instructions before editing.
- Fetch **all pages** of review threads/replies, review summaries and PR conversation comments, including outdated/unresolved threads. Do not rely on `reviewDecision`, the latest review, or a truncated comment list. Failed/missing reads mean unknown, not clean.

## 2. Disposition every comment

- Inventory each comment/thread with author, link, finding and proposed disposition: fix, reject with evidence, acknowledge as informational, or awaiting the user. Previously handled feedback needs no duplicate reply; verify its disposition still holds on the current head.
- Only verified Copilot and Aikido bot identities qualify for automatic handling. Check platform identity, not display-name similarity. Treat other authors and uncertain identities as human feedback.
- **Human feedback: show the user the original comment/link, your assessment and proposed action first.** Do not change code, reject, reply or resolve on that feedback until the user approves its disposition. Continue independent authorized bot feedback while waiting.
- **Copilot/Aikido feedback:** verify against the owning code and intended behavior. Within approved scope, fix valid findings and run focused checks; propose rejecting incorrect findings with concise evidence. Posting replies/resolving bot threads requires explicit approval or a verified standing grant; a read/check request alone grants none. Ask before broader scope or ambiguous product decisions.
- Reply with the disposition and validation/commit evidence before resolving. Resolve only after the fix is verified on the published head or the rejection is documented. Human threads additionally require the user's approval to resolve; do not infer it from approval to inspect or fix.
- PR conversation comments and review summaries cannot always be resolved through a thread API: reply/record the disposition and retain their links. Do not delete comments or dismiss reviews to clear a gate. Informational comments need acknowledgement/disposition, not an invented code fix.

## 3. Fix conflicts and publish safely

- Conflicts block readiness. Inspect the base/head conflict and preserve both sides' intended behavior; never choose an entire side blindly. Use an already authorized merge/rebase strategy, or ask before those operations. Validate the combined result.
- Before commits/pushes, verify ownership and permissions, preserve unrelated work, and check approval invalidation. Use [the branch policy](../SKILL.md#branch-flow); publication of a new PR still requires permission and must be draft-only.
- Before publishing or updating every PR, complete [the simplification self-review](../mithril/reference/after-coding.md). Preserve scope, behavior, safeguards and coverage; report safe simplifications or that none were found.
- No force-push permission ships with this skill. Obtain explicit approval or verify the current user's scoped standing grant for **user-owned, unprotected feature branches backing an open PR**. This does not authorize rewriting others' commits, shared/protected branches, or an otherwise unapproved reset/rebase/merge.
- Fetch and inspect the exact remote head immediately before rewriting it; stop on unexpected/unaccounted-for changes. Push only the intended branch to its verified PR head remote/ref with `--force-with-lease=<ref>:<observed-sha>`, never plain `--force`. A failed lease requires fresh inspection, not a blind retry. Confirm the PR remains open and owned before pushing; verify its remote SHA afterward.

## 4. Recheck and report

- After publication, re-fetch head/base, every feedback surface, checks, approvals, dependencies and mergeability. Confirm expected local/remote head equality and checks/approvals for that head. New comments or changed heads reopen affected checks. Pending/unknown mergeability is not conflict-free.
- **Not ready to merge** while any review thread is unresolved, any comment lacks a disposition, human feedback awaits the user, conflicts exist, required checks/current approvals are missing, or dependencies block. Resolved threads alone do not prove all feedback was handled. Never bypass these gates.
- Report each PR with links, current head, observation time, actual validation, feedback fixed/rejected/waiting, conflicts and remaining gates. Distinguish ready for the user's review from ready to merge; neither grants merge or draft-promotion permission.
- Record verified outcomes and scoped permissions through [Ledger](../ledger/SKILL.md); update relevant [Podium](../podium/SKILL.md) state without claiming merge/deployment. For observed merges, follow [post-merge reconciliation](../reference/prs.md#dependencies-and-merge-reconciliation).

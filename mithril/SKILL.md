---
name: mithril
description: "Use during coding or refactoring for necessity, reuse, size, SOLID, DRY, smells, security, and verification. Load specialist references only when relevant."
disable-model-invocation: true
---

# Mithril

Guidance, not automated enforcement. Keep core across phases; reread after context loss. Prioritize correctness/safety, repo conventions, clarity, then simplicity.

## Before editing

- **Brief.** Read acceptance criteria (ACs), invariants, checks; establish missing criteria with planner/user. Surface assumptions; clarify ambiguity that changes the solution, never silently change scope. For non-trivial work, give a short `step -> verification` plan; no separate document is required.
- **Necessity/reuse.** Check config/helpers/packages/siblings; reuse or explain why not. Recommend a materially simpler approach before building when it meets the same requirements; explain tradeoffs and get approval for scope changes. Never bypass canonical resolvers or duplicate rules. No speculative layers/options; check new dependencies for overlap, maintenance, provenance.
- **Full context.** Read changed files/owning methods in full, chunking large files. Trace entry through callers/helpers, validation, transformation, I/O, outputs/side effects, failures, tests. Flag unresolved links; names/hits/hunks aren't enough.

## While coding

- **Scope.** Each line serves the request/coupled fix. Match style; remove newly unused code, report unrelated debt. No defenses for states verified contracts exclude.
- **Efficiency/fidelity.** Remove unnecessary code, computation, I/O, dependencies and prose without losing behavior, correctness, error visibility, meaning or maintainability. Verify claimed gains; fewer lines alone are not an improvement.
- **Comments.** Keep comments brief; explain non-obvious rationale, contracts, warnings, or constraints, not what the code already says. Don't add comments by default.
- **Size/cohesion.** Files: 500 lines soft; propose meaningful split or justify cohesion above it. Methods: inspect at 20-30 lines or 3+ parameters; 60 lines soft, flag >100. Split responsibilities, not counts; avoid shallow helper chains. Repo thresholds override these advisory limits.
- **SOLID.** SRP: one change reason. OCP: extend real variation, preserve policy. LSP: preserve substitute contracts. ISP: focused client interfaces. DIP: policy uses stable boundaries, not concrete I/O. Prefer composition/injection; no needless interfaces or dependency cycles.
- **DRY.** Rules changing together have one owner; derive lists from registries. Similar text isn't necessarily duplicate knowledge. Avoid flag-heavy helpers merging unrelated cases. Thin adapters translate domain answers, never recompute rules.
- **Intent/contracts.** Precise names/units/constants; guards, named conditions, top-down flow. Separate queries/mutations. Preserve APIs/defaults/side effects/errors. Validate boundaries; distinguish absent/empty/malformed. Never swallow/disguise failure.
- **Security.** Server-side authorization/ownership/tenant checks; trusted identity scopes queries. Deny uncertainty. Parameterize queries, context-escape output, constrain paths/URLs, avoid unsafe deserialization. Established auth/crypto only; no secrets/personal data in source/logs/errors/fixtures/telemetry. Check changed dependency vulnerabilities.

## Load by phase

- **Planning:** read [planning](./reference/planning.md) for ACs, prior art, domain shape, verifiable slices.
- **After coding:** follow [review steps](./reference/after-coding.md), including simplification/efficiency. Fix in-scope findings and rerun affected checks; no extra agent required.
- Shared state, remote calls, caches, queries, migrations, config/deployment, operations: read matching [runtime safeguards](./reference/safeguards.md) only.

## Verification discipline

- Test behavior slices with unit tests catching plausible wrong implementations. Observe expected behavioral failure before production edits—not setup/import failure—then add enough code to pass. Acceptance tests complement unit tests. Characterize uncovered behavior before refactoring; keep tests green and structural cleanup separate from behavior changes. Report exceptions/gaps.
- Start narrow; combine related selectors. Broaden for repo policy, affected behavior or evidence, not each reviewer/fix. Reuse results only for unchanged code, dependencies, configuration and relevant environment; rerun affected checks after changes.
- Keep tested files stable; concurrent edits need an authorized isolated checkout/worktree. Isolate shared databases, ports, containers and other external state or sequence conflicting runs. Bind results to the tested snapshot, including dirty changes, not completion-time HEAD.
- Follow [Maestro's long-check workflow](../SKILL.md#long-checks-and-handoffs); required validation still gates completion/publication.

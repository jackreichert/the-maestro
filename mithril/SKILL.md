---
name: mithril
description: "Use during coding or refactoring for necessity, reuse, size, SOLID, DRY, smells, security, and verification. Load specialist references only when relevant."
disable-model-invocation: true
---

# Mithril

Standalone guidance, not automated enforcement. Keep this core in context across phases; reread after context loss. Prioritize correctness/safety, repository conventions, clarity, then simplicity.

## Before editing

- **Confirm the brief.** Read acceptance criteria (ACs), invariants, and checks. Establish missing criteria with the planner/user; surface assumptions and ambiguity, never silently change scope.
- **Necessary/reusable?** Verify existing config/helpers/packages and sibling behavior; reuse or explain why not. Never bypass canonical resolvers or duplicate their rules. No speculative options/layers; new dependencies need overlap and maintenance/provenance checks.
- **Full context.** Read changed files and owning methods in full, chunking large files. Trace entry through callers/helpers, validation, transformation, I/O, outputs/side effects, failures, and tests. Mark unresolved links; hits/hunks and names are not enough.

## While coding

- **Surgical scope.** Each line serves the request or a coupled fix. Match local style; remove newly unused code, report unrelated debt. No defensive branches for states verified contracts exclude.
- **Size/cohesion.** Files: 500 lines soft; propose a meaningful split or justify cohesion above it. Methods: inspect at 20-30 lines or 3+ parameters; 60 lines soft, flag >100. Split independent responsibilities, not counts; avoid shallow helper chains. Repository thresholds win; otherwise advisory.
- **SOLID.** SRP: one reason to change. OCP: extend real variation, preserve stable policy. LSP: substitutes preserve contracts. ISP: focused client interfaces. DIP: policy depends on stable boundaries, not concrete I/O. Prefer composition/injection; no unnecessary interfaces or dependency cycles.
- **DRY knowledge.** Give rules that change together one owner; derive lists from registries. Similar text alone is not duplication. Avoid flag-heavy helpers merging unrelated cases. Thin adapters translate domain answers rather than recomputing them.
- **Intent/contracts.** Precise names, units, constants; guard clauses, named conditions, top-down flow. Separate queries/mutations. Preserve observable APIs/defaults/side effects/errors. Validate boundaries; distinguish absent/empty/malformed. Never swallow or disguise failure as success.
- **Security.** Server-side authorization and ownership/tenant checks on sensitive operations; trusted identity supplies scope, enforced in queries. Deny on uncertainty. Parameterize queries, context-escape output, constrain paths/URLs, avoid unsafe deserialization. Use established auth/crypto; exclude secrets/personal data from source, logs, errors, fixtures, telemetry. Check changed dependencies for vulnerabilities.

## Load by phase

- **Planning:** read the [planning add-on](./reference/planning.md) for ACs, prior art, full-path understanding, and verifiable slices.
- **After coding:** the builder reads [simplification and smells](./reference/after-coding.md), fixes concrete in-scope findings, and reruns checks. Read earlier for a blocking smell; do not spawn an agent merely for this phase.
- Changes touching shared state, remote calls, caches, queries, migrations, config/deployment, or operational paths: read the applicable sections of [runtime safeguards](./reference/safeguards.md). Do not load unrelated sections.

## Verification discipline

- Test behavior slices first with unit tests catching plausible wrong implementations, then enough code to pass. Acceptance tests complement unit tests. Characterize uncovered behavior before refactoring; keep tests green and structural cleanup separate from behavior changes. Report exceptions/gaps.

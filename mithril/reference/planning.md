# Planning add-on

Read with the core when planning code changes; do not load the after-coding catalog just to plan.

- Extract ACs from the ticket/request: outcomes, constraints, invariants, and preserved behavior. Propose implicit criteria; ask about material ambiguity, never invent scope. Pair each criterion and plan step with verification.
- Verify prior art in repo, shared packages, stdlib, declared dependencies, and sibling implementations. Compare defaults, ordering, status mapping, empty input, and failures. Record reuse or why not; "not found" includes search scope, not proof of absence.
- Read relevant files and owning methods in full, chunking large files. Trace entry through callers/helpers, validation, transformation, I/O, outputs/side effects, failures, and tests. Mark unresolved links.
- Identify dependencies, risks, and test gaps. Read applicable runtime safeguards before choosing affected boundaries or migrations. Propose preparatory refactoring only where needed for safe implementation.
- Produce ordered, independently verifiable slices within Maestro's PR budget. Brief builders with ACs/checks, invariants, reuse decisions, scope/permissions, relevant findings, and remaining uncertainty.

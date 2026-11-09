# Planning add-on

Read with [core](../SKILL.md) when planning; no after-coding catalog needed.

For project shaping or technical documents, also use [Planning](../../planning/SKILL.md); this add-on covers coding checks.

- Extract ACs: outcomes, constraints, invariants, preserved behavior. Propose implicit criteria; clarify material ambiguity, never invent scope. Pair ACs/steps with checks.
- Verify repo/shared-package/stdlib/dependency/sibling prior art. Compare defaults, ordering, status mapping, empty input, failures. Record reuse/rejection; "not found" includes search scope, not proof of absence.
- Apply core's full-context trace to relevant files/methods; flag unresolved links.
- Establish domain shape/invariants before logic. Prefer existing types/validated constructors that exclude invalid states; model alternatives explicitly, not ambiguous flags/temporary fields. Preserve clear local designs; no speculative type hierarchies.
- Identify dependencies/risks/test gaps; read matching runtime safeguards before choosing boundaries/migrations. Refactor first only when safe implementation requires it.
- Before coding, check base/target heads, divergence and integration order for conflicts/rework. Preserve branch policy; ask before changing it. Plan focused checks, required broader suites and isolated resources.
- Follow [Maestro's slice and size rules](../../SKILL.md#pr-size): complete behavior boundaries, self-contained wiring/tests/docs, and safe merge into the intended base without later fixes. Brief ACs/checks, invariants, reuse, scope/permissions, findings, uncertainty.

# After coding: simplify and verify

Builder self-review after implementation, or earlier for blocking smells; no extra agent required. Use with [core](../SKILL.md).

1. Read changed files/diff against ACs; recheck necessity, reuse, callers/defaults, matching safeguards.
2. Inspect smells below; fix concrete in-scope maintenance costs with minimal behavior-preserving changes/tests green. Respect local idioms: records, loops, switches, inheritance, delegation can be appropriate. Smells signal investigation, not defects.
3. Shorten changed comments without losing clarity or rationale/contracts/warnings/constraints. Correct stale claims, remove narration/commented-out code, update docs.
4. Rerun focused tests/type checks/repo lint/build after fixes. Test behavior, not implementation/prompt wording. Report results/skips; metrics block only at written thresholds.
5. Report every AC → check → result/evidence, unmet/unverified items, remaining findings. Done requires all ACs passing or user-approved changes.

Independent reviewers return findings, locations, consequences, suggested moves—not manuals. Builder verifies/fixes/reruns checks within Maestro's bounded loop.

After two fixes fail the same check, state/revalidate their shared premise against reproduction, contracts, state ownership before retrying. Fix causes, not concealing guards. No review-cap reset or scope expansion.

## Smell patterns and remedies

| Smell | Pattern → response |
|-------|--------------------|
| Mysterious Name | Unclear purpose → name domain intent. |
| Duplicated Code | Repeated decision → shared owner. |
| Long Function | Multiple concerns/narration → coherent steps, decomposed conditions, split loops. |
| Long Parameter List | Scattered inputs/flags → cohesive object or separate behaviors. |
| Data Clumps | Fields travel together → group them. |
| Primitive Obsession | Strings/numbers carry rules → validated domain types. |
| Large Class | Disjoint behavior/state → split responsibilities. |
| Global Data | Remote mutation → localize/encapsulate ownership. |
| Mutable Data | Needless updates/stored derivations → copies/derivation; separate queries/mutations. |
| Data Class | Callers own exposed data's behavior → encapsulate/move behavior to owner. |
| Temporary Field | Fields valid on some paths → separate case/type. |
| Divergent Change | Unrelated reasons to change → split change axes. |
| Shotgun Surgery | One rule touches many modules → consolidate rule. |
| Repeated Switches | Repeated type dispatch → centralize; useful polymorphism only. |
| Feature Envy | Uses another owner's data → move behavior nearer data. |
| Message Chains | Navigates layer internals → focused operation. |
| Middle Man | Only forwards/hides nothing → inline/remove. |
| Insider Trading | Coupled internals → move behavior/narrow boundaries. |
| Lazy Element | No useful behavior/concept → inline. |
| Speculative Generality | Unused hooks/options/hierarchies → remove until needed. |
| Refused Bequest | Rejects inherited behavior → reshape hierarchy/composition. |
| Alternative Classes with Different Interfaces | Same role/incompatible APIs → align genuinely interchangeable contracts. |
| Loops | Plumbing obscures intent → clearer collection operations where simpler. |
| Comments | Stale/narrating/commented-out code → correct/remove; improve names/extract behavior. Retain rationale/contracts/warnings/constraints. |

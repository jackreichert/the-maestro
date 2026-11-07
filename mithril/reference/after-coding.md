# After coding: simplify and verify

The builder reads this after implementation and performs the pass itself; no extra agent required. Read it earlier if a smell blocks implementation.

1. Read changed files in full and inspect the diff against the ACs. Recheck necessity, reuse, affected callers/defaults, and applicable runtime safeguards.
2. Look for the patterns below. Fix only concrete maintenance costs in scope, using the smallest behavior-preserving move with tests green. Respect local idioms; records, loops, switches, inheritance, and delegation can be appropriate. A smell is a signal, not a defect.
3. Simplify added/changed comments without losing rationale, contracts, warnings, or constraints. Correct stale claims; remove narration/commented-out code. Keep docs accurate.
4. Rerun focused tests, type checks, and repository lint/build gates after fixes. Test behavior, not implementation details or prompt wording. Report actual results/skips; metrics block only with written thresholds.
5. Report each AC → check → result/evidence, including unmet/unverified items and remaining findings. Not done until all ACs pass or the user changes them.

For an independent review, return only specific findings, source locations, consequences, and suggested moves to the builder, not the entire manual. The builder verifies each finding, fixes it, and reruns checks. Follow Maestro's bounded review loop.

## Smell patterns and remedies

| Smell | Pattern → response |
|-------|--------------------|
| Mysterious Name | Purpose unclear → rename for domain intent. |
| Duplicated Code | Same decision maintained twice → extract a shared owner. |
| Long Function | Multiple concerns or narration needed → extract coherent steps; decompose conditions/split loops. |
| Long Parameter List | Scattered inputs or behavior flags → pass a cohesive object or separate behaviors. |
| Data Clumps | Same fields repeatedly travel together → group related values. |
| Primitive Obsession | Raw strings/numbers carry domain rules → use validated domain types. |
| Large Class | Disjoint fields/behaviors → extract independent responsibilities. |
| Global Data | State changed from afar → encapsulate/localize ownership. |
| Mutable Data | Needless updates or stored derived values → prefer copies/derivation; separate queries and mutations. |
| Data Class | Callers own behavior tied to exposed data → encapsulate and move behavior to its owner. |
| Temporary Field | Fields meaningful only on some paths → model a separate case/type. |
| Divergent Change | One module changes for unrelated reasons → split change axes. |
| Shotgun Surgery | One rule change touches many modules → consolidate that rule. |
| Repeated Switches | Same type dispatch repeated → centralize dispatch; use polymorphism where useful. |
| Feature Envy | Function mostly uses another owner's data → move behavior nearer that data. |
| Message Chains | Caller navigates another layer's internals → expose a focused operation. |
| Middle Man | Layer only forwards, hiding nothing useful → inline/remove it. |
| Insider Trading | Modules depend on each other's internals → move behavior and narrow boundaries. |
| Lazy Element | Function/class adds no useful behavior or concept → inline it. |
| Speculative Generality | Unused hooks/options/hierarchies → remove until needed. |
| Refused Bequest | Subclass ignores/rejects inherited behavior → reshape hierarchy or use composition. |
| Alternative Classes with Different Interfaces | Same role, incompatible APIs → align contracts where genuinely interchangeable. |
| Loops | Hand-written collection plumbing obscures intent → use clear collection operations when simpler. |
| Comments | Stale, narrating code/history, or commented-out code → correct/remove; improve names or extract behavior. Keep rationale, contracts, warnings, constraints. |

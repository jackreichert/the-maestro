# After coding: simplify and verify

Builder self-review after implementation, or earlier for blocking smells; no extra agent required. Use with [core](../SKILL.md).

1. Read changed files/diff against ACs; recheck necessity, reuse, callers/defaults, matching safeguards.
2. Fix concrete in-scope maintenance costs with behavior-preserving changes/tests green. Use the optional prompts below only for unclear code; idioms and line counts alone are not defects.
3. Keep changed comments brief without losing rationale, contracts, warnings, or constraints. Correct stale claims; remove narration and commented-out code.
4. Rerun focused tests/type checks/repo lint/build after fixes. Test behavior, not implementation/prompt wording. Report results/skips; metrics block only at written thresholds.
5. Report every AC → check → result/evidence, unmet/unverified items, remaining findings. Done requires all ACs passing or user-approved changes.

Independent reviewers return findings, locations, consequences, suggested moves—not manuals. Builder verifies/fixes/reruns checks within Maestro's bounded loop.

After two fixes fail the same check, state/revalidate their shared premise against reproduction, contracts, state ownership before retrying. Fix causes, not concealing guards. No review-cap reset or scope expansion.

## Optional simplification prompts

- **Intent:** do names and contracts explain the domain without narrating comments?
- **Ownership:** does each rule/state have one owner? Move behavior to its owner instead of exposing internals or adding forwarding layers.
- **Cohesion:** split unrelated responsibilities; group values that travel together. Prefer explicit alternatives over ambiguous flags or temporary fields.
- **Necessity:** remove unused options, abstractions and stored derivations; reuse genuinely shared rules, not superficially similar code.
- **Control flow:** simplify plumbing only when clearer; loops, records, switches and composition are valid local idioms. Preserve public behavior and failure visibility.

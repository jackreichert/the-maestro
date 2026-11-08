---
title: "<Technical design>"
project: "<repo or agreed cross-repo project>"
status: draft
updated: "<YYYY-MM-DD>"
approval: null
source_revisions: []
tickets: []
---

# <Technical design>

## Recommendation

<Problem/approach/why; canonical goals/scope/non-goals link.>

## Current system and evidence

<Boundaries/flows/prior art, revisions/checks; label facts, hypotheses, ruled-out causes.>

## Options

| Option | Benefits | Costs / risks | Disposition / rationale |
|---|---|---|---|
| <Reuse/no change/viable alternative> | <Outcome> | <Tradeoffs> | <Recommended/rejected/proposed> |

## Proposed design

<Components/ownership, domain model/invariants, input/output contracts, data/control flows, side effects; diagram if clearer.>

## Failure and operational behavior

<Validation/auth/privacy, errors, concurrency/retries, performance limits, observability, compatibility/migration; justify safety-critical exclusions.>

## Verification and delivery

<AC/check mapping or canonical plan link; unit/integration/acceptance tests, verifiable slices, rollout gates, rollback/recovery checks.>

## Open decisions and handoff

<Unknowns/spikes; question hashes/proposals, gates/options/recommendations; approval source/scope, dependencies, next step. Link decisions/plan, don't duplicate.>

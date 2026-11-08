---
name: library
description: "Use to onboard to a repo, find reusable context before code research, or maintain verified human-readable architecture, concepts, working guides, and runbooks."
disable-model-invocation: true
---

# Library

Human-readable onboarding and reusable repo memory, not a search log. Newcomers and Haiku scouts share an entry point.

## Organize by meaning

- Resolve `VAULT_ROOT`/repo; ask if unknown. Entry: `Projects/<repo>/Knowledge/README.md`; concept pages beside it; runbooks in `Projects/<repo>/Runbooks/`.
- Entry explains purpose/boundaries and links working guide, architecture, concepts, troubleshooting. Link authoritative README/config/docs; don't duplicate commands/policy.
- Organize by concept/subsystem, not file/directory. Individual file pages need important entry points or non-obvious behavior. Use [the template](./page-template.md); omit unused sections.
- Explain vocabulary, flows, integrations, setup/build/test, sources, conventions, pitfalls for an incoming engineer. Current guidance precedes history.
- Link canonical vault plans/decisions and ledger records; `tickets` metadata attributes supporting pages to the most specific ticket.

## Scout workflow

1. Search library terms/aliases; inspect titles and **Read when**.
2. Verify sources in code: read owning files/methods and trace affected flow.
3. On a miss, search code, then retry library with discovered symbols/subsystems. Report search scope/unresolved links.
4. Brief behavior, reuse candidates, constraints, evidence, uncertainty. Haiku suits substantial independent scouting; keep short lookups/continuous traces in-thread.
5. Patch verified discoveries, stale claims, missing explanations, or broken links only. Read-only scouts propose patches to the writer; no extra maintenance agent.

## Maintain useful knowledge

- Pages identify repo, concepts/aliases, read-when, paths/symbols, evidence, related pages, and verification: what was checked at which revision. Opening a page or changing its date proves nothing.
- Derived README table: title/link, read-when, aliases, source anchors, verification state. Rebuild after additions/renames without overwriting authored onboarding prose.
- Reuse canonical pages, including archived/superseded knowledge; preserve edits and serialize repo writes. Source changes flag affected pages for revalidation.
- Promote verified reusable discoveries, not routine searches/task state. Keep hypotheses clearly labeled in the ledger.
- No secrets/personal data in examples, commands, logs, diagrams. Never inspect `.env*`/`ssm-*.json`; use placeholders/safe references.

## Turn-end and maps

For `Stop`, follow [Ledger's checkpoint contract](../ledger/SKILL.md): prepared verified patches only, stable IDs, revision checks, serialized writes, separate read-back acknowledgements/retries. Preserve conflicts; never claim proposals applied. Refresh affected links/index and record page/application receipts without hook loops. Ledger, Podium, and library are separate writes, not one transaction. Slim `PreCompact` flushes prepared continuation only; no discovery or whole-library rewrites. Hooks/indexers are not implemented.

Prefer small Mermaid flow diagrams. UML/Graphify is optional for complex/unfamiliar boundaries; scope safely and verify relationships. Maps support prose, never replace it or regenerate every turn.

Acceptance: newcomer/fresh Haiku finds the right subsystem, understands behavior, and locates verified build/test guidance without reading the whole repo.

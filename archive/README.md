# Archive

Retired tools, kept for reference and easy restore. Nothing here is imported, typechecked or run by the suite (`tsconfig.json` and `npm test` only cover `scripts/`). To restore one, `git mv` it back under `scripts/` and re-add the README entry.

| Tool | Archived | Why |
|---|---|---|
| `scripts/memory-diet.ts` (+ test) | 2026-10-15 | A read-only classifier for fixture text. No SKILL.md, playbook, event type, hook, README or overlay entry ever pointed to it, so no protocol step runs it. |
| `scripts/rule-audit.ts` (+ test) | 2026-10-15 | A read-only audit of rule files for an enforced-by value. No SKILL.md, playbook, event type, hook, README or overlay entry ever pointed to it, so no protocol step runs it. |

The relative imports in archived files (for example `./lib/withhold.ts`) are written for their old location and are not kept working.

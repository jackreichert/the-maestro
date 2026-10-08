# The library: page template and vocabulary

The library is the distilled layer above the ledger: one canonical page per fact-bearing topic, written in a fixed shape so a script can route, check and index it. The ledger records what happened; the library says how things work and how to do them. A page cites its evidence and never restates a decision, a status or a secret.

## Where pages live

| Path (under the vault root) | What |
|---|---|
| `Projects/<repo>/Knowledge/<topic>.md` | How it works, gotchas, decision pointers, tool notes. One page per topic or component. |
| `Projects/<repo>/Runbooks/<task>.md` | How to do a recurring thing, step by step, linking the helper that does it. |
| `Projects/<repo>/Knowledge/flows/<flow>.md` | A flow that crosses repos. Lives under the project that owns the flow (`dev-env` for cross-repo flows). |
| `Projects/<repo>/INDEX.md` | The repo's component list (frontmatter `components`) and a line per page. |

`notes-check` and the stream tab read `Knowledge/` as well as Plans, Research, Reviews and Runbooks, one subfolder deep, so a page with a `stream:` field is listed on that stream's tab with no further step.

## Frontmatter

Every page starts with this block. All fields are required unless marked optional.

```yaml
---
type: library
kind: how-it-works          # one of the kinds below
repo: avonlea-api           # the project folder the page lives in
stream: Avonlea             # the stream tab that lists it
components: [orchard-sync]  # each one is in the repo's INDEX.md list
status: current             # current | stale | superseded
verified-at: 2026-10-08     # YYYY-MM-DD, optionally followed by @<sha>
verify-how: "read packages/orchard/src/sync.ts:40-52"   # the command or file:line that re-checks it
composed-by: composer       # who wrote it; the composer is the only writer
ticket: none
sources: []                 # optional: learned ids behind the page
depends-on: []              # optional: pages this one relies on
supersedes: []              # optional: pages this one replaces
superseded-by:              # optional, required when status is superseded
---
```

## Controlled vocabulary

| Field | Allowed values |
|---|---|
| `kind` | `how-to`, `how-it-works`, `runbook`, `decision`, `gotcha`, `tool` |
| `status` | `current`, `stale`, `superseded` |
| `repo` | a folder under `Projects/` that matches the page's own folder |
| `stream` | a stream name (the stream whose tab should list the page) |
| `components` | only values in the `components` list of `Projects/<repo>/INDEX.md` |

Adding a component is a deliberate edit to that list, so `interim-db`, `interimdb` and `cubhub` cannot all appear. A `decision` page is a pointer to DECISIONS.md and never restates the decision.

The component list is the `components` array in the frontmatter of `Projects/<repo>/INDEX.md`:

```yaml
---
type: library-index
repo: avonlea-api
components: [orchard-sync, harvest-export]
---
```

## Body

1. A heading with the topic.
2. A line starting `Read when:` that says in one sentence when to open the page.
3. A `## Facts` section. Each fact is one bullet on one line, claim first, and ends `(verified YYYY-MM-DD, <evidence>)` where evidence is a file:line, a sha, a PR or a vault path. Never the value of a secret. `library-check` treats every non-blank line under `## Facts` that is not a heading as a fact, so a numbered item or a prose line needs the same ending (or belongs in another section).
4. Optional `## Links`: one-hop wikilinks to related pages and to the Plans or Research note that established a fact.
5. Optional `## History`: superseded values with their date and why. Replace a changed fact in place and move the old value here; never append.

A page stays under 150 lines, and its History is never longer than its Facts.

## What a page never holds

No secret (a key, token, password, connection string with credentials, or an env variable followed by its value: name the variable, never the value), no PHI, and no status ("PR merged"). `library-check` refuses the first two by pattern; the pattern list is a floor, not a proof, so write systems, ids and counts only.

## Checking

`node scripts/library-check.ts` reads every page and exits 1 when any page breaks a rule above. Run it on the pages before anyone trusts them.

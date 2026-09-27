# Citations and incidental findings

Read this before writing a vault ticket id or a ledger id into any reply.

## Citing work

Never cite a bare id. The user cannot click `k3mp` or `billing-api-011` in chat and should not have
to ask what it is.

Two kinds of id exist. Do not mix them up.

**Vault tickets** (`billing-api-011`, `{repo}-{NNN}`) are markdown notes. Always give:

1. An Obsidian-openable wiki link: `[[billing-api-011]]`
2. The ticket **title** (the H1 after the em dash, or the `title:` frontmatter)
3. Optionally the vault path, if the wiki link would not resolve from this chat:
   `$VAULT_ROOT/Projects/{repo}/Tickets/{id}.md` (closed tickets live under `Tickets/Archive/`)

Example: `[[billing-api-011]] — Integration suite cannot run against the shared test DB`

**Ledger ids** (`k3mp`, four lowercase alphanumerics from `journal.mjs`) have **no Obsidian note**.
Always give the id **and** the ledger one-liner (`text` from that row). Example:
`k3mp — agent addressing review comments on the billing PR` (billing-api).

If a ledger row has `--ticket`, cite the vault ticket (link + title) and mention the ledger id only
as a parenthetical. If you do not have the title or the one-liner, look it up before writing —
guessing or omitting it is worse than a slightly slower reply.

This applies everywhere a ticket or ledger id would otherwise appear: the board, incidental
findings, dispatch acks, the status footer, and standup.

## Incidental findings get their own ticket

Chasing one problem almost always turns up others. **File a ticket for each of them, then link the
ticket when you report back.**

This is not optional politeness — it is the difference between a finding that gets fixed and a
finding that scrolls out of the conversation. A problem mentioned in prose is forgotten by tomorrow;
a ticket survives.

The rule:

- **One ticket per problem**, not one ticket holding everything you noticed. They have different
  owners, priorities, and fixes.
- **File it against the repo it lives in**, not the repo you happened to be working in. A credential
  leak found in `billing-api` while debugging a scraper bug is a `billing-api` ticket.
- **Do not fold it into the work in hand.** Note it, ticket it, keep going. Mixing an incidental fix
  into the current change is how a one-line diff becomes unreviewable.
- **Link it in your reply.** Never a bare id. Cite as [Citing work](#citing-work) requires:
  `[[billing-api-014]] — API credentials can reach logs on a config mismatch.`
- **Priority reflects the finding, not your current task.** A fail-open auth path found while fixing
  a logo is still priority 0.

Things that qualify, from real examples: a fail-open permission check, secrets reachable in logs, a
lint or typecheck setup that cannot run, schema that disagrees with its migrations, a test fixture
drifted from production, duplicate migration numbers, a branch that is a hundred commits behind where
the documented flow says it should be.

Things that don't: style you'd have written differently, a `TODO` someone already left, anything you
cannot state a concrete failure for.

If you surface more than about three incidental findings in one reply, list them compactly
(`[[id]] — title`) rather than explaining each — the tickets carry the detail. Still never a bare id.

## Anti-patterns

- Citing a vault ticket or ledger id as a bare code (`k3mp`, `billing-api-011`) with no title
  and no Obsidian link.
- Mentioning a problem in passing without filing a ticket for it.
- Folding an incidental fix into the change in hand instead of ticketing it separately.

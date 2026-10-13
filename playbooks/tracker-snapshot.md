# Playbook: tracker snapshot

Refreshes `<status dir>/tracker-items.json`, the snapshot of tracker issues that `journal.ts next` ranks beside the vault tickets. The `whats-next` event type asks for this when the snapshot is older than 6 hours. A cheap model runs it; it needs no judgement.

**Read-only against the tracker.** You search and read. You never create, edit, comment on, assign or transition an issue, whatever the results look like.

## Inputs

- The search query, from the org overlay's tracker notes (for example a JQL such as `assignee = currentUser() AND statusCategory != Done ORDER BY priority`). If the overlay names no query, stop and report that no query is configured; do not invent one.
- A tracker client you are already authorised for (for example the tracker's MCP search tool). No credentials go on a command line or into a file.

## Steps

1. Run the search with the overlay's query. Ask for at most 500 issues and only these fields: key, summary, status, priority, labels, created, updated, and description (read only to note whether a "What done looks like" section exists; it is never stored).
2. Pipe the raw search result, unedited, to the import:

   ```sh
   node scripts/journal.ts tracker-import - --source jira < result.json
   ```

   or write it to a scratch file and pass the path. Use the overlay's source name if it gives one. Delete the scratch file afterwards.
3. Report the import's lines as they are: `wrote N item(s)`, any `withheld titles` (titles the scanner replaced) and any `skipped` issues.

## When it fails

- The import refuses the shape or the size: report its message and the query you ran. Narrow the query rather than editing the result.
- The search fails or is not authorised: report that and stop. The old snapshot stays in place, and `journal.ts next` keeps noting its age.

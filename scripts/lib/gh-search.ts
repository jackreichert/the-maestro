/**
 * Paginated `gh api graphql` search shared by the pr-watch event type and prs-snapshot.ts.
 *
 * The query must declare `$after: String`, pass `after: $after` to `search(...)`, and select
 * `pageInfo { hasNextPage endCursor }` beside `nodes`. Returns every node across all pages.
 * A GraphQL `errors` array or a missing `search` object throws: callers treat that as a failed
 * fetch, never as "every PR closed".
 */
import { execFileSync } from 'node:child_process';
import type { Run } from './types.ts';

/** One search result node; the fields differ by query, so callers narrow it. */
export type SearchNode = Record<string, unknown>;

interface SearchPage { nodes: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
interface GraphqlResponse { errors?: { message?: string }[]; data?: { search?: SearchPage } }

const MAX_PAGES = 40;

// The default runner throws on a failed gh; a caller's `run` (the event loop's ctx.run) returns { status, stdout, stderr } instead.
const execGh: Run = (cmd, args) => ({ status: 0, stderr: '', stdout: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) });

function fetchPage(query: string, after: string | null, run: Run): SearchPage {
  const cursorArgs = after ? ['-f', `after=${after}`] : [];
  const r = run('gh', ['api', 'graphql', '-f', `query=${query}`, ...cursorArgs]);
  if (r.status !== 0) throw new Error(`gh api graphql failed: ${String(r.stderr || '').split('\n')[0]}`);
  const out = r.stdout;
  const parsed = JSON.parse(out) as GraphqlResponse;
  const search = parsed.data?.search;
  if (parsed.errors?.length || !search) {
    throw new Error(`partial GraphQL response: ${parsed.errors?.[0]?.message || 'no search data'}`);
  }
  return search;
}

/**
 * Fetches every page of a search query and returns the concatenated, non-null nodes. `run(cmd, args)` defaults to a throwing execFileSync.
 * `N` is the node shape the query selects; gh's JSON is not validated against it, so it is only as right as the query.
 */
export function searchAllPages<N = SearchNode>(query: string, run: Run = execGh): N[] {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = fetchPage(query, after, run);
    nodes.push(...(result.nodes.filter(Boolean) as N[]));
    if (!result.pageInfo?.hasNextPage) return nodes;
    after = result.pageInfo.endCursor ?? null;
    if (!after) throw new Error('search reported another page but no endCursor');
  }
  throw new Error(`search still had more results after ${MAX_PAGES} pages`);
}

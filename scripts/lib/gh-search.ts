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
import { toolCommand } from './tool-bin.ts';

/** What a GitHub node id looks like; anything else is never put in a query's text. */
export const NODE_ID = /^[A-Za-z0-9_=-]+$/;
/** PRs per by-id read: 25 PRs with thread detail cost about 52 points. */
export const NODES_BATCH = 25;

/** One search result node; the fields differ by query, so callers narrow it. */
export type SearchNode = Record<string, unknown>;

interface SearchPage { nodes: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
interface GraphqlResponse { errors?: { message?: string }[]; data?: { search?: SearchPage } }

const MAX_PAGES = 40;

// The default runner throws on a failed gh; a caller's `run` (the event loop's ctx.run) returns { status, stdout, stderr } instead.
const execGh: Run = (cmd, args) => ({ status: 0, stderr: '', stdout: execFileSync(...toolCommand(cmd, args), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) });

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
 * Like `searchAllPages`, but a page that fails after the first one does not lose the pages already read: it returns them with the error. A first page
 * that fails still throws, so a caller never mistakes "could not read" for "nothing open".
 */
export function searchPagesPartial<N = SearchNode>(query: string, run: Run = execGh): { nodes: N[]; error?: Error } {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let result: SearchPage;
    try { result = fetchPage(query, after, run); } catch (e) {
      if (page === 0) throw e;
      return { nodes, error: e instanceof Error ? e : new Error(String(e)) };
    }
    nodes.push(...(result.nodes.filter(Boolean) as N[]));
    if (!result.pageInfo?.hasNextPage) return { nodes };
    after = result.pageInfo.endCursor ?? null;
    if (!after) return { nodes, error: new Error('search reported another page but no endCursor') };
  }
  return { nodes, error: new Error(`search still had more results after ${MAX_PAGES} pages`) };
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

/**
 * Reads pull requests by node id, `NODES_BATCH` at a time, selecting `selection` (the fields after `id`) on each. Returns them by id; a PR GitHub no longer
 * returns (closed or deleted in between) has no entry. This is the second half of a cheap-search-then-detail read: GraphQL charges for the connections
 * nested inside a search's nodes, so the costly fields are read here only for the PRs that need them. Ids are checked before they enter the query text.
 */
export function readNodesById<N extends { id: string }>(ids: string[], selection: string, run: Run = execGh): Map<string, N> {
  const out = new Map<string, N>();
  for (let i = 0; i < ids.length; i += NODES_BATCH) {
    const batch = ids.slice(i, i + NODES_BATCH);
    if (!batch.every((id) => NODE_ID.test(id))) throw new Error('GitHub returned an id that is not a plain node id');
    const query = `query { nodes(ids: [${batch.map((id) => `"${id}"`).join(', ')}]) { ... on PullRequest { id ${selection} } } }`;
    const r = run('gh', ['api', 'graphql', '-f', `query=${query}`]);
    if (r.status !== 0) throw new Error(`gh api graphql (nodes by id) failed: ${String(r.stderr || '').split('\n')[0]}`);
    const parsed = JSON.parse(r.stdout) as { errors?: { message?: string }[]; data?: { nodes?: (N | null)[] } };
    if (parsed.errors?.length || !parsed.data?.nodes) throw new Error(`partial GraphQL response: ${parsed.errors?.[0]?.message || 'no nodes data'}`);
    for (const n of parsed.data.nodes) if (n?.id) out.set(n.id, n);
  }
  return out;
}

/** PRs per by-key read: ten PRs with their threads and reviews cost about 20 points. */
export const KEYS_BATCH = 10;
const PR_KEY = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)#([1-9][0-9]{0,8})$/;

export interface PullsRead<N> {
  /** The PRs read, by the key they were asked for. */
  nodes: Map<string, N>;
  /** Keys GitHub says do not exist (deleted, renamed away, or not visible to the token). */
  gone: string[];
  /** Keys whose batch could not be read, so nothing is known of them; `error` is the first such failure. */
  failed: string[];
  error?: Error;
}

/**
 * Reads named pull requests (`owner/repo#number`), `KEYS_BATCH` at a time, one aliased `repository(...) { pullRequest(...) }` per key, selecting `selection` on each.
 * This is the read that replaced searching every open PR: only the PRs asked for cost anything. A key that is not shaped like a PR key is never put in the query text
 * and is reported as failed. A batch that fails does not lose the batches already read: its keys come back in `failed`, so a caller never mistakes "could not read" for "gone".
 */
export function readPullRequests<N>(keys: readonly string[], selection: string, run: Run = execGh): PullsRead<N> {
  const out: PullsRead<N> = { nodes: new Map(), gone: [], failed: [] };
  const fail = (batch: readonly string[], e: unknown): void => { out.failed.push(...batch); out.error ??= e instanceof Error ? e : new Error(String(e)); };
  const ok: string[] = [];
  for (const k of keys) { if (PR_KEY.test(k)) ok.push(k); else fail([k], new Error(`not a PR key: ${k.slice(0, 60)}`)); }
  for (let i = 0; i < ok.length; i += KEYS_BATCH) {
    const batch = ok.slice(i, i + KEYS_BATCH);
    const body = batch.map((k, n) => { const m = PR_KEY.exec(k) as RegExpExecArray; return `p${n}: repository(owner: "${m[1]}", name: "${m[2]}") { pullRequest(number: ${m[3]}) { ${selection} } }`; }).join('\n');
    try {
      const r = run('gh', ['api', 'graphql', '-f', `query=query {\n${body}\n}`]);
      if (r.status !== 0) throw new Error(`gh api graphql (PRs by key) failed: ${String(r.stderr || '').split('\n')[0]}`);
      const parsed = JSON.parse(r.stdout) as { errors?: { type?: string; message?: string; path?: unknown[] }[]; data?: Record<string, { pullRequest?: N | null } | null> | null };
      const errors = parsed.errors ?? [];
      const missing = new Set(errors.filter((e) => e.type === 'NOT_FOUND').map((e) => String(e.path?.[0] ?? '')));
      const other = errors.find((e) => e.type !== 'NOT_FOUND');
      if (other || !parsed.data) throw new Error(`partial GraphQL response: ${other?.message || 'no data'}`);
      batch.forEach((k, n) => {
        const pr = parsed.data?.[`p${n}`]?.pullRequest;
        if (pr) out.nodes.set(k, pr);
        else if (missing.has(`p${n}`) || parsed.data?.[`p${n}`] === null || parsed.data?.[`p${n}`]?.pullRequest === null) out.gone.push(k);
        else fail([k], new Error('GitHub returned no data for this PR'));
      });
    } catch (e) { fail(batch, e); }
  }
  return out;
}

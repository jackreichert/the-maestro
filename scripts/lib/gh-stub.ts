/**
 * Test support: a fake `gh` behind MAESTRO_GH_BIN so the PR scripts run offline, with no executable written.
 *
 * `installGhStub(config)` writes the fake's script into a temp dir and returns the env (MAESTRO_GH_BIN and
 * MAESTRO_GH_BIN_ARGS point at it through node) to run a script with. `config`: { pages: [nodes[], ...], prState?: 'OPEN' | 'MERGED', failOnPage?: n }. Page i is served
 * for the cursor `p<i>` the stub itself hands out as endCursor, so a script that ignores
 * `pageInfo` only ever sees page 0. It answers `api user`, `api graphql`, `pr view` (with `--json`: `prView`), `pr edit`, `pr ready`.
 * `delayMs: n` makes `api graphql` sleep n ms before answering; `callLog: path` records each `api graphql` call (a by-id `nodes(ids: [...])` read is logged as `detail <ids>` and answered from the same nodes). `editLog: path` records each `pr edit` argv line; `readyLog: path` each `pr ready` argv line. `failOnPage: n` makes the request for page n exit 1, as a gateway error mid-pagination would.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { stubEnv, writeStub } from './stub-bin.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GhStubConfig { pages: unknown[][]; prState?: 'OPEN' | 'MERGED' | 'CLOSED'; failOnPage?: number; editLog?: string; delayMs?: number; callLog?: string; prView?: unknown; readyLog?: string }

const STUB = `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const cfg = JSON.parse(readFileSync(process.env.GH_STUB_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const cursor = argv.find((a) => a.startsWith('after='));
const page = cursor ? Number(cursor.slice('after=p'.length)) : 0;
const queryArg = argv.find((a) => a.startsWith('query='));
const idsAsked = queryArg && queryArg.includes('nodes(ids:') ? [...queryArg.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
if (argv[0] === 'api' && argv[1] === 'user') console.log('me');
else if (argv[0] === 'api' && idsAsked) {
  if (cfg.callLog) appendFileSync(cfg.callLog, 'detail ' + idsAsked.join(',') + '\\n');
  console.log(JSON.stringify({ data: { nodes: cfg.pages.flat().filter((n) => idsAsked.includes(n.id)) } }));
} else if (argv[0] === 'api' && cfg.delayMs) {
  if (cfg.callLog) appendFileSync(cfg.callLog, 'call\\n');
  setTimeout(() => { console.log(JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: cfg.pages[0] } } })); }, cfg.delayMs);
} else if (argv[0] === 'api' && cfg.failOnPage === page) {
  console.error('HTTP 502: bad gateway');
  process.exit(1);
} else if (argv[0] === 'api') {
  const pages = cfg.pages;
  console.log(JSON.stringify({ data: { search: {
    pageInfo: { hasNextPage: page < pages.length - 1, endCursor: 'p' + (page + 1) },
    nodes: pages[page],
  } } }));
} else if (argv[0] === 'pr' && argv[1] === 'edit') { if (cfg.editLog) appendFileSync(cfg.editLog, argv.join(' ') + '\\n'); }
else if (argv[0] === 'pr' && argv[1] === 'ready') { if (cfg.readyLog) appendFileSync(cfg.readyLog, argv.join(' ') + '\\n'); }
else if (argv[0] === 'pr' && argv[1] === 'view' && cfg.prView && argv.includes('--json') && !argv.includes('--jq')) console.log(JSON.stringify(cfg.prView));
else if (argv[0] === 'pr' && argv[1] === 'view') console.log(cfg.prState || 'OPEN');
`;

/** Writes the stub and returns an env (the gh seam + config) for spawning a script against it. */
export function installGhStub(config: GhStubConfig): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  const stub = writeStub(join(dir, 'gh.cjs'), STUB);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { ...process.env, ...stubEnv('MAESTRO_GH_BIN', stub), GH_STUB_CONFIG: configPath, MAESTRO_LOCAL_CONFIG: '', MAESTRO_WATCH_QUIET_HOURS: 'off' };
}

/** A search node carrying every field the pr-watch event type and prs-snapshot.ts read. */
export function prNode(number: number, overrides: Record<string, unknown> = {}) {
  // updatedAt moves with the content, as GitHub's does: pr-watch re-reads a PR's threads and comments only when it moves.
  const moved = [...JSON.stringify(overrides)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000, 0) * (Object.keys(overrides).length ? 1 : 0);
  return {
    id: `PR_${String((overrides.repository as { nameWithOwner?: string } | undefined)?.nameWithOwner ?? 'org/repo').replace(/\W/g, '_')}_${number}`,
    number,
    title: 'x',
    url: `https://github.com/org/repo/pull/${number}`,
    isDraft: false,
    headRefName: 'feat',
    baseRefName: 'develop',
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: new Date(Date.parse('2026-09-24T00:00:00Z') + moved * 1000).toISOString(),
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    headRefOid: 'sha-a',
    repository: { nameWithOwner: 'org/repo' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    reviews: { nodes: [] },
    ...overrides,
  };
}

/** Splits nodes into pages of `size`, the way the search API serves them. */
export const paged = <T>(nodes: T[], size = 50): T[][] =>
  Array.from({ length: Math.ceil(nodes.length / size) }, (_, i) => nodes.slice(i * size, (i + 1) * size));

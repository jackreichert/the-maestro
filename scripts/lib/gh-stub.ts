/**
 * Test support: a fake `gh` on PATH so the PR scripts run offline.
 *
 * `installGhStub(config)` writes an executable `gh` into a temp dir and returns the env to run a
 * script with. `config`: { pages: [nodes[], ...], prState?: 'OPEN' | 'MERGED', failOnPage?: n }. Page i is served
 * for the cursor `p<i>` the stub itself hands out as endCursor, so a script that ignores
 * `pageInfo` only ever sees page 0. It answers `api user`, `api graphql`, `pr view`, `pr edit`.
 * `editLog: path` records each `pr edit` argv line. `failOnPage: n` makes the request for page n exit 1, as a gateway error mid-pagination would.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GhStubConfig { pages: unknown[][]; prState?: 'OPEN' | 'MERGED' | 'CLOSED'; failOnPage?: number; editLog?: string }

const STUB = `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const cfg = JSON.parse(readFileSync(process.env.GH_STUB_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const cursor = argv.find((a) => a.startsWith('after='));
const page = cursor ? Number(cursor.slice('after=p'.length)) : 0;
if (argv[0] === 'api' && argv[1] === 'user') console.log('me');
else if (argv[0] === 'api' && cfg.failOnPage === page) {
  console.error('HTTP 502: bad gateway');
  process.exit(1);
} else if (argv[0] === 'api') {
  const pages = cfg.pages;
  console.log(JSON.stringify({ data: { search: {
    pageInfo: { hasNextPage: page < pages.length - 1, endCursor: 'p' + (page + 1) },
    nodes: pages[page],
  } } }));
} else if (argv[0] === 'pr' && argv[1] === 'edit') { if (cfg.editLog) appendFileSync(cfg.editLog, argv.join(' ') + '\\n'); }
else if (argv[0] === 'pr' && argv[1] === 'view') console.log(cfg.prState || 'OPEN');
`;

/** Writes the stub and returns an env (PATH + config) for spawning a script against it. */
export function installGhStub(config: GhStubConfig): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  writeFileSync(join(dir, 'gh'), STUB);
  chmodSync(join(dir, 'gh'), 0o755);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_STUB_CONFIG: configPath, MAESTRO_LOCAL_CONFIG: '', MAESTRO_WATCH_QUIET_HOURS: 'off' };
}

/** A search node carrying every field the pr-watch event type and prs-snapshot.ts read. */
export function prNode(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: 'x',
    url: `https://github.com/org/repo/pull/${number}`,
    isDraft: false,
    headRefName: 'feat',
    baseRefName: 'develop',
    createdAt: '2026-09-23T00:00:00Z',
    updatedAt: '2026-09-24T00:00:00Z',
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

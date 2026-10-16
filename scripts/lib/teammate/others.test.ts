// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/others.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../types.ts';
import { DETAIL_REFRESH_MS, fetchOthers, OTHERS_CACHE, othersSearch, readOthersCache, reduceOthers, refreshOthers, writeOthersCache } from './others.ts';
import type { OtherPr } from './others.ts';

const SCOPE = { owners: ['acme'], selfRepos: ['acme/solo'], self: 'me-fake' };
const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 1, title: 't', url: 'https://github.com/acme/app/pull/1', isDraft: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
  baseRefName: 'develop', headRefName: 'feat/x', reviewDecision: null, author: { login: 'pat-fake', __typename: 'User' }, repository: { nameWithOwner: 'acme/app' },
  reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});
const stored = (over: Partial<OtherPr> = {}): OtherPr => ({ repo: 'acme/app', number: 1, title: 't', url: 'u', author: 'pat-fake', base: 'develop', head: 'h', createdAt: 'c', updatedAt: 'u', requested: [], decision: null, unresolved: 0, copilotThreads: 0, ...over });
const dir = (): string => mkdtempSync(join(tmpdir(), 'others-test-'));

test('the search is scoped to the owners and never runs without one', () => {
  assert.equal(othersSearch([]), null);
  assert.equal(othersSearch(['bad owner', 'x;y']), null);
  assert.match(othersSearch(['acme', 'beta']) ?? '', /^is:pr is:open archived:false -author:@me user:acme user:beta$/);
});

test('the author\'s display name is kept when GitHub gives one, and a blank one is not', () => {
  const named = reduceOthers([node({ author: { login: 'pat-fake', __typename: 'User', name: '  Pat Example ' } }), node({ number: 2, author: { login: 'kim-fake', __typename: 'User', name: ' ' } })] as never, SCOPE);
  assert.deepEqual(named.map((p) => [p.author, p.authorName]), [['pat-fake', 'Pat Example'], ['kim-fake', undefined]]);
});

test('own PRs, bots, self-review repos and other owners are left out; newest activity leads', () => {
  const out = reduceOthers([
    node({ number: 1 }),
    node({ number: 2, author: { login: 'ME-fake', __typename: 'User' } }),
    node({ number: 3, author: { login: 'dependabot[bot]', __typename: 'Bot' } }),
    node({ number: 5, repository: { nameWithOwner: 'acme/solo' } }),
    node({ number: 6, repository: { nameWithOwner: 'other/app' } }),
    node({ number: 7, updatedAt: '2026-10-05T00:00:00Z' }),
    node({ number: 8, author: null }),
  ] as never, SCOPE);
  assert.deepEqual(out.map((p) => p.number), [7, 1]);
});

test('drafts are kept and flagged, with checks, mergeability, labels, your review and the head time', () => {
  const me = { login: 'ME-fake' };
  const [d, p] = reduceOthers([node({ number: 4, isDraft: true }), node({
    number: 5, mergeable: 'CONFLICTING', labels: { nodes: [{ name: 'wip' }, null] }, commits: { nodes: [{ commit: { committedDate: '2026-10-03T00:00:00Z', statusCheckRollup: { state: 'FAILURE' } } }] },
    reviews: { nodes: [{ author: me, state: 'COMMENTED', submittedAt: '2026-10-02T00:00:00Z' }, { author: me, state: 'PENDING', submittedAt: '2026-10-04T00:00:00Z' }, { author: { login: 'kim-fake' }, state: 'APPROVED', submittedAt: '2026-10-05T00:00:00Z' }] },
  })] as never, SCOPE);
  assert.equal(d?.isDraft, true);
  assert.deepEqual([p?.isDraft, p?.ci, p?.mergeable, p?.labels, p?.yourReview, p?.headAt, p?.reviewCount], [false, 'FAILURE', 'CONFLICTING', ['wip'], { state: 'COMMENTED', at: '2026-10-02T00:00:00Z' }, '2026-10-03T00:00:00Z', 2]);
});

test('requested reviewers, decision and open threads (Copilot ones counted apart) are read from the node', () => {
  const t = (resolved: boolean, login: string): unknown => ({ isResolved: resolved, comments: { nodes: [{ author: { login, __typename: 'Bot' } }] } });
  const [p] = reduceOthers([node({
    reviewDecision: 'CHANGES_REQUESTED', reviewRequests: { nodes: [{ requestedReviewer: { login: 'me-fake' } }, { requestedReviewer: {} }, null] },
    reviewThreads: { nodes: [t(false, 'copilot-pull-request-reviewer'), t(true, 'copilot-pull-request-reviewer'), t(false, 'pat-fake')] },
  })] as never, SCOPE);
  assert.deepEqual([p?.requested, p?.decision, p?.unresolved, p?.copilotThreads], [['me-fake'], 'CHANGES_REQUESTED', 2, 1]);
});

test('the cache round-trips and a damaged one reads as absent', () => {
  const d = dir();
  assert.equal(readOthersCache(d), null);
  const at = new Date('2026-10-15T12:00:00Z');
  writeOthersCache(d, { fetchedAt: at, prs: [stored()] });
  assert.deepEqual(readOthersCache(d)?.prs, [stored()]);
  assert.equal(readOthersCache(d)?.fetchedAt?.toISOString(), at.toISOString());
  writeFileSync(join(d, OTHERS_CACHE), '{"fetched_at":"2026-10-15T12:00:00Z","prs":[{"number":"x"}]}');
  assert.equal(readOthersCache(d), null);
});

test('a failed read keeps the last good list and its time, and says why; with no list it still records the failure', () => {
  const d = dir();
  const first = new Date('2026-10-15T12:00:00Z');
  refreshOthers(d, SCOPE, first, () => [stored()]);
  const kept = refreshOthers(d, SCOPE, new Date('2026-10-15T13:00:00Z'), () => { throw new Error('gh api graphql failed: rate limited\nmore'); });
  assert.deepEqual([kept.prs.length, kept.fetchedAt?.toISOString(), kept.failure], [1, first.toISOString(), 'gh api graphql failed: rate limited']);
  assert.equal(readOthersCache(d)?.failure, 'gh api graphql failed: rate limited');
  const empty = refreshOthers(dir(), SCOPE, first, () => { throw new Error('boom'); });
  assert.deepEqual([empty.prs, empty.fetchedAt, empty.failure], [[], null, 'boom']);
});

/** A gh that serves `nodes` as one search page and answers by-id reads from `detail`, recording the ids each read asked for. */
function fakeGh(nodes: unknown[], detail: Record<string, unknown>): { run: Run; reads: string[][] } {
  const reads: string[][] = [];
  const run: Run = (_cmd, args) => {
    const query = args.find((a) => a.startsWith('query=')) ?? '';
    if (!query.includes('nodes(ids:')) return { status: 0, stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes } } }), stderr: '' };
    const ids = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    reads.push(ids);
    return { status: 0, stdout: JSON.stringify({ data: { nodes: ids.map((id) => ({ id, ...(detail[id] as object) })) } }), stderr: '' };
  };
  return { run, reads };
}
const thread = (login: string): unknown => ({ isResolved: false, comments: { nodes: [{ author: { login, __typename: 'Bot' } }] } });

test('threads are read by id only for PRs with open threads, and only when their updatedAt moved (850 points a refresh became about 50)', () => {
  const quiet = node({ id: 'PR_1', number: 1, url: 'https://github.com/acme/app/pull/1' });
  const busy = node({ id: 'PR_2', number: 2, url: 'https://github.com/acme/app/pull/2', reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } });
  const g = fakeGh([quiet, busy], { PR_2: { reviewThreads: { nodes: [thread('copilot-pull-request-reviewer'), { isResolved: true, comments: { nodes: [] } }] } } });
  const first = fetchOthers(SCOPE, g.run);
  assert.deepEqual(g.reads, [['PR_2']], 'the quiet PR has no thread to attribute');
  assert.deepEqual(first.map((p) => [p.number, p.unresolved, p.copilotThreads]).sort(), [[1, 0, 0], [2, 1, 1]]);
  const again = fetchOthers(SCOPE, g.run, first);
  assert.equal(g.reads.length, 1, 'unchanged, so nothing is read in detail');
  assert.deepEqual(again.map((p) => [p.number, p.unresolved, p.copilotThreads]).sort(), [[1, 0, 0], [2, 1, 1]], 'the Copilot count is carried from the stored list');
  const later = fakeGh([quiet, busy], { PR_2: { reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: 'pat-fake' } }] } }] } } });
  const refreshed = fetchOthers(SCOPE, later.run, first, Date.now() + DETAIL_REFRESH_MS + 1);
  assert.deepEqual(later.reads, [['PR_2']], 'read again after the refresh age though updatedAt did not move');
  assert.equal(refreshed.find((p) => p.number === 2)?.copilotThreads, 0, 'a Copilot thread that was resolved no longer counts');
  const moved = fakeGh([quiet, { ...busy, updatedAt: '2026-10-09T00:00:00Z' }], { PR_2: { reviewThreads: { nodes: [thread('pat-fake')] } } });
  assert.deepEqual(fetchOthers(SCOPE, moved.run, first).map((p) => [p.number, p.copilotThreads]).sort(), [[1, 0], [2, 0]]);
  assert.deepEqual(moved.reads, [['PR_2']], 'a changed PR is read again');
});

test('refreshOthers hands the stored list to the fetch, so a refresh can skip what has not changed', () => {
  const d = dir();
  refreshOthers(d, SCOPE, new Date('2026-10-15T12:00:00Z'), () => [stored({ url: 'https://x/1' })]);
  let seen: readonly OtherPr[] = [];
  refreshOthers(d, SCOPE, new Date('2026-10-15T12:10:00Z'), (_scope, known) => { seen = known; return []; });
  assert.deepEqual(seen.map((p) => p.url), ['https://x/1']);
});

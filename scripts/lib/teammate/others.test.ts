// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/others.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OTHERS_CACHE, othersSearch, readOthersCache, reduceOthers, refreshOthers, writeOthersCache } from './others.ts';
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
  assert.match(othersSearch(['acme', 'beta']) ?? '', /^is:pr is:open draft:false archived:false -author:@me user:acme user:beta$/);
});

test('the author\'s display name is kept when GitHub gives one, and a blank one is not', () => {
  const named = reduceOthers([node({ author: { login: 'pat-fake', __typename: 'User', name: '  Pat Example ' } }), node({ number: 2, author: { login: 'kim-fake', __typename: 'User', name: ' ' } })] as never, SCOPE);
  assert.deepEqual(named.map((p) => [p.author, p.authorName]), [['pat-fake', 'Pat Example'], ['kim-fake', undefined]]);
});

test('own PRs, bots, drafts, self-review repos and other owners are left out; newest activity leads', () => {
  const out = reduceOthers([
    node({ number: 1 }),
    node({ number: 2, author: { login: 'ME-fake', __typename: 'User' } }),
    node({ number: 3, author: { login: 'dependabot[bot]', __typename: 'Bot' } }),
    node({ number: 4, isDraft: true }),
    node({ number: 5, repository: { nameWithOwner: 'acme/solo' } }),
    node({ number: 6, repository: { nameWithOwner: 'other/app' } }),
    node({ number: 7, updatedAt: '2026-10-05T00:00:00Z' }),
    node({ number: 8, author: null }),
  ] as never, SCOPE);
  assert.deepEqual(out.map((p) => p.number), [7, 1]);
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

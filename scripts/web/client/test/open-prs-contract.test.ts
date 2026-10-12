// Run: node --test scripts/web/client/test/open-prs-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOpenPrs, sanitizeRefreshStatus } from '../src/contract.ts';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 1, title: 't', url: 'https://github.com/a/b/pull/1', base: 'main', head: 'h', isDraft: false, review: 'none', unresolved: 0, mergeable: 'unknown', twins: [], ...over,
});
const body = (repos: unknown[]): Record<string, unknown> => ({
  generatedAt: '2026-10-12T15:00:00Z', prData: { fetchedAt: null, stale: true }, total: 99,
  groups: [{ id: 'team', label: 'Team repos', count: 99, repos }],
});

test('a good body passes and its counts are recomputed from the rows that survive', () => {
  const got = sanitizeOpenPrs(body([{ repo: 'a/b', count: 50, prs: [row(), row({ number: 2 })] }]));
  assert.ok(got);
  assert.equal(got.dropped, 0);
  assert.equal(got.data.total, 2);
  assert.equal(got.data.groups[0].count, 2);
  assert.equal(got.data.groups[0].repos[0].count, 2);
});

test('a repo block with a malformed row is dropped whole and counted, never shown with a wrong count', () => {
  const got = sanitizeOpenPrs(body([{ repo: 'a/b', count: 2, prs: [row(), row({ review: 'bogus' })] }, { repo: 'c/d', count: 1, prs: [row()] }]));
  assert.ok(got);
  assert.equal(got.dropped, 1);
  assert.deepEqual(got.data.groups[0].repos.map((r) => r.repo), ['c/d']);
  assert.equal(got.data.total, 1);
});

test('a body with no usable shape is refused', () => {
  for (const x of [null, [], 'x', {}, { generatedAt: 'x', groups: [] }, { generatedAt: 'x', prData: { fetchedAt: 3, stale: true }, groups: [] }]) assert.equal(sanitizeOpenPrs(x), null);
});

test('refresh status accepts the five states and refuses anything else', () => {
  for (const state of ['idle', 'running', 'done', 'failed', 'locked']) assert.equal(sanitizeRefreshStatus({ state })?.state, state);
  assert.equal(sanitizeRefreshStatus({ state: 'weird' }), null);
  assert.equal(sanitizeRefreshStatus(null), null);
  assert.deepEqual(sanitizeRefreshStatus({ state: 'failed', message: 'm', extra: 1 }), { state: 'failed', message: 'm' });
});

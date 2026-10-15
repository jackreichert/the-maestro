// Run: node --test scripts/web/client/test/others-prs-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOthersPrs } from '../src/contract.ts';
import { OthersPrsStore } from '../src/others-prs-store.ts';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'a/b', number: 1, title: 't', url: 'https://github.com/a/b/pull/1', author: 'pat-fake', base: 'develop', updatedAt: '2026-10-15T00:00:00Z', youAsked: false, review: 'review-required', unresolved: 0, copilotThreads: 0, ...over,
});
const body = (prs: unknown[]): Record<string, unknown> => ({ generatedAt: '2026-10-15T12:00:00Z', prData: { fetchedAt: null, stale: true }, total: 99, prs });

test('a good body passes and the total follows the rows kept; a bad row is dropped and counted', () => {
  const got = sanitizeOthersPrs(body([row(), row({ number: 2, review: 'bogus' }), row({ number: 3 })]));
  assert.ok(got);
  assert.deepEqual([got.data.total, got.dropped, got.data.prs.map((p) => p.number)], [2, 1, [1, 3]]);
});

test('a body with no usable shape is refused', () => {
  assert.equal(sanitizeOthersPrs(null), null);
  assert.equal(sanitizeOthersPrs({ generatedAt: 'x', prs: [] }), null);
  assert.equal(sanitizeOthersPrs({ ...body([]), prData: { fetchedAt: 5, stale: true } }), null);
});

test('the store keeps the list it has when a read fails, and tells its listeners', async () => {
  const data = sanitizeOthersPrs(body([row()]))?.data ?? null;
  let next = data;
  const store = new OthersPrsStore(async () => next);
  let heard = 0;
  store.subscribe(() => { heard += 1; });
  await store.load();
  next = null;
  await store.load();
  assert.deepEqual([store.model.loaded, store.model.data?.total, heard], [true, 1, 2]);
});

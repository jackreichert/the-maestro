// Run: node --test scripts/web/client/test/open-prs-store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenPrsStore } from '../src/open-prs-store.ts';
import type { OpenPrsDeps } from '../src/open-prs-store.ts';
import type { OpenPrsData, PrsRefreshStatus } from '../src/types.ts';

const data = (total: number): OpenPrsData => ({ generatedAt: '2026-10-12T15:00:00Z', prData: { fetchedAt: '2026-10-12T14:59:00Z', stale: false }, total, groups: [] });

function deps(over: Partial<OpenPrsDeps> & { statuses?: (PrsRefreshStatus | null)[] } = {}): { d: OpenPrsDeps; calls: { post: number; load: number; status: number } } {
  const calls = { post: 0, load: 0, status: 0 };
  const statuses = over.statuses ?? [{ state: 'done' }];
  const d: OpenPrsDeps = {
    load: async () => { calls.load += 1; return data(calls.load); },
    status: async () => statuses[Math.min(calls.status++, statuses.length - 1)] ?? null,
    post: async () => { calls.post += 1; return 202; },
    delay: async () => {},
    ...over,
  };
  return { d, calls };
}

test('a press posts once, polls until the server is done, then reloads the table', async () => {
  const { d, calls } = deps({ statuses: [{ state: 'running' }, { state: 'running' }, { state: 'done' }] });
  const store = new OpenPrsStore(d);
  const seen: string[] = [];
  store.subscribe(() => seen.push(store.model.refresh.kind));
  await store.refresh();
  assert.equal(calls.post, 1);
  assert.equal(calls.status, 3);
  assert.equal(calls.load, 1, 'the table is reloaded once the refresh finishes');
  assert.equal(store.model.data?.total, 1);
  assert.equal(seen[0], 'running');
  assert.equal(store.model.refresh.kind, 'done');
});

test('repeat clicks while a refresh is in flight make no second request', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => { release = ok; });
  const { d, calls } = deps({ delay: () => gate });
  const store = new OpenPrsStore(d);
  const first = store.refresh();
  await store.refresh();
  await store.refresh();
  assert.equal(calls.post, 1);
  assert.equal(store.model.refresh.kind, 'running');
  release();
  await first;
  await store.refresh();
  assert.equal(calls.post, 2, 'a press after the first finished is a new refresh');
});

test('a failed refresh shows the server reason and still reloads the table', async () => {
  const { d, calls } = deps({ statuses: [{ state: 'failed', message: 'GitHub could not be read (rate limit).' }] });
  const store = new OpenPrsStore(d);
  await store.refresh();
  assert.deepEqual(store.model.refresh, { kind: 'failed', message: 'GitHub could not be read (rate limit).' });
  assert.equal(calls.load, 1);
});

test('the refresh lock held by another rebuild shows as locked, not as a failure', async () => {
  const { d } = deps({ statuses: [{ state: 'locked', message: 'A status page refresh is already running.' }] });
  const store = new OpenPrsStore(d);
  await store.refresh();
  assert.equal(store.model.refresh.kind, 'locked');
  assert.match(store.model.refresh.message ?? '', /already running/);
});

test('409 busy is treated as running, so the press waits for the refresh already under way', async () => {
  const { d, calls } = deps({ post: async () => 409, statuses: [{ state: 'running' }, { state: 'done' }] });
  const store = new OpenPrsStore(d);
  await store.refresh();
  assert.equal(calls.status, 2);
  assert.equal(store.model.refresh.kind, 'done');
});

test('no edit token, a refused request and a thrown request all fail visibly without polling', async () => {
  for (const post of [async () => null, async () => 400, async () => { throw new Error('offline'); }]) {
    const { d, calls } = deps({ post });
    const store = new OpenPrsStore(d);
    await store.refresh();
    assert.equal(store.model.refresh.kind, 'failed');
    assert.ok(store.model.refresh.message);
    assert.equal(calls.status, 0);
    await store.refresh();   // the button works again afterwards
  }
});

test('an unreadable status and a refresh that never finishes both end in a failure, not a spinner', async () => {
  const lost = new OpenPrsStore(deps({ statuses: [null] }).d);
  await lost.refresh();
  assert.equal(lost.model.refresh.kind, 'failed');
  const slow = new OpenPrsStore(deps({ statuses: [{ state: 'running' }], maxPolls: 3 }).d);
  await slow.refresh();
  assert.equal(slow.model.refresh.kind, 'failed');
  assert.match(slow.model.refresh.message ?? '', /longer than expected/);
});

test('a failed table read keeps the data already shown', async () => {
  let n = 0;
  const store = new OpenPrsStore(deps({ load: async () => (n++ === 0 ? data(4) : null) }).d);
  await store.load();
  await store.load();
  assert.equal(store.model.data?.total, 4);
  assert.equal(store.model.loaded, true);
});

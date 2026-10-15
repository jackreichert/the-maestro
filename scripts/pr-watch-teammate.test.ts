// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/pr-watch-teammate.test.ts
// The teammate PR helper inside pr-watch: the 15 minute wait, once per head, scoping, and a failing search not failing the check.
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as prWatch from './event-types/pr-watch.ts';
import { advanceHelper, selectWaiting, teammateSearch } from './lib/teammate/wait.ts';
import type { WaitNode } from './lib/teammate/wait.ts';
import type { Run } from './lib/types.ts';

const T0 = Date.parse('2026-10-14T12:00:00Z');
const MIN = 60_000;
const node = (over: Partial<WaitNode> = {}): WaitNode => ({
  number: 12, url: 'https://github.com/acme/widgets/pull/12', isDraft: false, headRefOid: 'a'.repeat(40), headRefName: 'feat/x', baseRefName: 'main',
  createdAt: new Date(T0 - 20 * MIN).toISOString(), reviewDecision: null, author: { login: 'teammate', __typename: 'User' },
  repository: { nameWithOwner: 'acme/widgets' }, reviews: { nodes: [] }, timelineItems: { nodes: [] }, ...over,
});
const O = { self: 'me', minutes: 15, now: T0, selfRepos: [] as string[] };

test('a ready PR by someone else qualifies at exactly 15 minutes and not at 14', () => {
  assert.equal(selectWaiting([node({ createdAt: new Date(T0 - 15 * MIN).toISOString() })], O).length, 1);
  assert.equal(selectWaiting([node({ createdAt: new Date(T0 - 14 * MIN - 59_000).toISOString() })], O).length, 0);
});

test('the clock is the last ready-for-review event, not when the PR was opened', () => {
  const late = node({ createdAt: new Date(T0 - 3 * 3600_000).toISOString(), timelineItems: { nodes: [{ createdAt: new Date(T0 - 5 * MIN).toISOString() }] } });
  assert.equal(selectWaiting([late], O).length, 0);
});

test('never your own PR, a draft, a bot author, a self-review repo, a reviewed or decided PR', () => {
  const cases: [string, WaitNode, string[]][] = [
    ['own PR', node({ author: { login: 'ME', __typename: 'User' } }), []],
    ['draft', node({ isDraft: true }), []],
    ['bot author', node({ author: { login: 'dependabot[bot]', __typename: 'Bot' } }), []],
    ['self-review repo', node(), ['acme/*']],
    ['already reviewed by a person', node({ reviews: { nodes: [{ author: { login: 'other', __typename: 'User' }, state: 'COMMENTED' }] } }), []],
    ['reviewed by you', node({ reviews: { nodes: [{ author: { login: 'me', __typename: 'User' }, state: 'COMMENTED' }] } }), []],
    ['approved', node({ reviewDecision: 'APPROVED' }), []],
    ['changes requested', node({ reviewDecision: 'CHANGES_REQUESTED' }), []],
  ];
  for (const [name, n, selfRepos] of cases) assert.equal(selectWaiting([n], { ...O, selfRepos }).length, 0, name);
  assert.equal(selectWaiting([node({ reviews: { nodes: [{ author: { login: 'cop[bot]', __typename: 'Bot' }, state: 'COMMENTED' }] } })], O).length, 1, 'a bot review does not count as being reviewed');
});

test('off by default: zero minutes selects nothing, and an empty owner list builds no search at all', () => {
  assert.deepEqual(selectWaiting([node()], { ...O, minutes: 0 }), []);
  assert.equal(teammateSearch([]), null);
  assert.equal(teammateSearch(['bad owner"; x']), null, 'an unsafe owner is dropped, never searched');
  assert.match(teammateSearch(['acme']) ?? '', /^is:pr is:open draft:false -author:@me org:acme$/);
});

test('advanceHelper adopts silently with no record, speaks once for a newly waiting PR, and gives a push its own wait', () => {
  const MIN = 15; const T0 = 1_000_000_000_000;
  const w = selectWaiting([node()], O);
  const first = advanceHelper(undefined, w, false, T0, MIN);
  assert.deepEqual(first.events, [], 'the first run adopts what is already waiting');
  assert.deepEqual(advanceHelper(first.told, w, false, T0 + 60_000, MIN).events, []);
  const fresh = advanceHelper({}, w, false, T0, MIN);
  assert.match(fresh.events[0]?.summary ?? '', /^REVIEW-WAIT acme\/widgets#12 https:\/\/github\.com\/acme\/widgets\/pull\/12 waiting 20 min, head aaaaaaa$/);
  assert.deepEqual(advanceHelper(fresh.told, w, false, T0 + 3_600_000, MIN).events, [], 'told once per head');
  assert.deepEqual(advanceHelper({}, w, true, T0, MIN).events, [], 'a silent baseline says nothing');
  // A push starts a new wait: three pushes in a row say nothing until the last head has stood for the whole wait.
  let rec = fresh.told;
  for (const [i, sha] of ['b', 'c', 'd'].entries()) {
    const r = advanceHelper(rec, selectWaiting([node({ headRefOid: sha.repeat(40) })], O), false, T0 + (i + 1) * 120_000, MIN);
    assert.deepEqual(r.events, [], `push ${sha} is not reported at once`);
    rec = r.told;
  }
  const stood = advanceHelper(rec, selectWaiting([node({ headRefOid: 'd'.repeat(40) })], O), false, T0 + 3 * 120_000 + 16 * 60_000, MIN);
  assert.match(stood.events[0]?.summary ?? '', /waiting 16 min, head ddddddd$/);
  assert.deepEqual(advanceHelper(stood.told, selectWaiting([node({ headRefOid: 'd'.repeat(40) })], O), false, T0 + 3_600_000 * 5, MIN).events, []);
});

/** A fake gh: the teammate search (recognised by its draft:false term) answers `waiting`; any other search is the user's own board, empty. */
function rig(waiting: () => unknown[] | Error): { tick: (at: number) => string[]; log: string[] } {
  const log: string[] = [];
  const run: Run = (_cmd, args) => {
    const q = args.find((a) => a.startsWith('query=')) ?? '';
    log.push(q.includes('draft:false') ? 'teammate' : 'own');
    const nodes = q.includes('draft:false') ? waiting() : [];
    if (nodes instanceof Error) return { status: 1, stdout: '', stderr: nodes.message };
    return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes } } }) };
  };
  let prev: prWatch.PrWatchState | undefined;
  const config = { ghLogin: 'me', selfReviewRepos: [] as string[], teammateMinutes: 15, teammateOwners: ['acme'] };
  return {
    log,
    tick(at: number): string[] {
      const next = prWatch.check('open-prs', { run, now: T0 + at, prev, config });
      const lines = prWatch.diff(prev ?? null, next).map((e) => e.summary).filter((s) => s.startsWith('REVIEW-WAIT'));
      prev = next;
      return lines;
    },
  };
}

test('pr-watch end to end: adopt, then a new waiting PR speaks once; a failing teammate search does not fail the check', () => {
  let nodes: unknown[] = [node({ number: 1 })];
  let broken = false;
  const r = rig(() => (broken ? new Error('HTTP 502') : nodes));
  assert.deepEqual(r.tick(0), [], 'first run adopts the PR that was already waiting');
  nodes = [node({ number: 1 }), node({ number: 2, url: 'https://github.com/acme/widgets/pull/2' })];
  assert.equal(r.tick(MIN).length, 1);
  assert.deepEqual(r.tick(2 * MIN), [], 'told once');
  broken = true;
  assert.deepEqual(r.tick(3 * MIN), [], 'the search failed: no throw, no lines');
  broken = false;
  assert.deepEqual(r.tick(4 * MIN), [], 'the record survived the failed tick, so nothing is repeated');
});

test('with no minutes configured pr-watch never runs the teammate search', () => {
  const log: string[] = [];
  const run: Run = (_c, args) => { log.push(args.join(' ')); return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }) }; };
  prWatch.check('open-prs', { run, now: T0, config: { ghLogin: 'me', selfReviewRepos: [], teammateMinutes: 0, teammateOwners: ['acme'] } });
  assert.equal(log.some((l) => l.includes('draft:false')), false);
});

test('a hands-off repo is not reviewed unless the user is a requested reviewer or the owner wrote it; every other repo is open to review', () => {
  const o = { ...O, handsOff: { repos: ['*/guarded'], owner: 'owner-fake' } };
  const guarded = { repository: { nameWithOwner: 'acme/guarded' } };
  assert.equal(selectWaiting([node(guarded)], o).length, 0);
  assert.equal(selectWaiting([node({ ...guarded, reviewRequests: { nodes: [{ requestedReviewer: { login: 'someone-else' } }] } })], o).length, 0);
  assert.equal(selectWaiting([node({ ...guarded, reviewRequests: { nodes: [{ requestedReviewer: { login: 'ME' } }] } })], o).length, 1);
  assert.equal(selectWaiting([node({ ...guarded, author: { login: 'Owner-Fake', __typename: 'User' } })], o).length, 1, 'the owner\'s own PRs there are in scope');
  assert.equal(selectWaiting([node()], o).length, 1, 'a repo where the user was not asked is still reviewed');
  assert.equal(selectWaiting([node(guarded)], O).length, 1, 'with nothing configured nothing is hands off');
});

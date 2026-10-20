// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/pr-watch-teammate.test.ts
// The teammate PR helper inside pr-watch: the 15 minute wait, once per head, scoping, and a failing search not failing the check.
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as prWatch from './event-types/pr-watch.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceHelper, selectWaiting, WAIT_SELECTION } from './lib/teammate/wait.ts';
import { addToList, listPath } from './lib/teammate/others-list.ts';
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

test('off by default: zero minutes selects nothing; a merged or closed PR is never selected', () => {
  assert.deepEqual(selectWaiting([node()], { ...O, minutes: 0 }), []);
  assert.deepEqual(selectWaiting([node({ state: 'MERGED' }), node({ number: 13, state: 'CLOSED' })], O), []);
  assert.equal(selectWaiting([node({ state: 'OPEN' })], O).length, 1);
  assert.match(WAIT_SELECTION, /timelineItems\(last: 1, itemTypes: \[READY_FOR_REVIEW_EVENT\]\)/);
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

/** The key of a node, as the list names it. */
const keyOf = (n: WaitNode): string => `${n.repository.nameWithOwner}#${n.number}`.toLowerCase();

/**
 * A fake gh and a status directory. The Others' PRs list holds `listed`; reading a listed PR by key answers from `waiting()` (an Error is a failed read); the user's own
 * board is empty. `log` records what was asked: 'own' for the board search, 'listed' for a by-key read, 'search' for any other search (there must be none).
 */
function rig(waiting: () => WaitNode[] | Error, listed: string[]): { tick: (at: number) => string[]; log: string[]; statusDir: string } {
  const log: string[] = [];
  const statusDir = mkdtempSync(join(tmpdir(), 'pr-watch-list-'));
  for (const k of listed) addToList(listPath(statusDir), { key: k, source: 'manual' }, T0);
  const run: Run = (_cmd, args) => {
    const q = args.find((a) => a.startsWith('query=')) ?? '';
    if (q.includes('repository(owner:')) {
      log.push('listed');
      const nodes = waiting();
      if (nodes instanceof Error) return { status: 1, stdout: '', stderr: nodes.message };
      const data: Record<string, unknown> = {};
      for (const m of q.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) data[m[1] as string] = { pullRequest: nodes.find((n) => keyOf(n) === `${m[2]}/${m[3]}#${m[4]}`.toLowerCase()) ?? null };
      return { status: 0, stderr: '', stdout: JSON.stringify({ data }) };
    }
    log.push(q.includes('draft:false') ? 'search' : 'own');
    return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }) };
  };
  let prev: prWatch.PrWatchState | undefined;
  const config = { ghLogin: 'me', selfReviewRepos: [] as string[], teammateMinutes: 15, statusDir };
  return {
    log, statusDir,
    tick(at: number): string[] {
      const next = prWatch.check('open-prs', { run, now: T0 + at, prev, config });
      const lines = prWatch.diff(prev ?? null, next).map((e) => e.summary).filter((s) => s.startsWith('REVIEW-WAIT'));
      prev = next;
      return lines;
    },
  };
}

const W = (n: number): WaitNode => node({ number: n, url: `https://github.com/acme/widgets/pull/${n}` });

test('pr-watch end to end: adopt, then a newly listed waiting PR speaks once; a failing read does not fail the check', () => {
  let nodes: WaitNode[] = [W(1), W(2)];
  let broken = false;
  const r = rig(() => (broken ? new Error('HTTP 502') : nodes), ['acme/widgets#1']);
  assert.deepEqual(r.tick(0), [], 'first run adopts the PR that was already waiting');
  addToList(listPath(r.statusDir), { key: 'acme/widgets#2', source: 'review-request' }, T0 + MIN);
  assert.equal(r.tick(MIN).length, 1);
  assert.deepEqual(r.tick(2 * MIN), [], 'told once');
  broken = true;
  assert.deepEqual(r.tick(3 * MIN), [], 'the read failed: no throw, no lines');
  broken = false;
  assert.deepEqual(r.tick(4 * MIN), [], 'the record survived the failed tick, so nothing is repeated');
});

test('a PR that is not on the list is never read, so it is never reviewed unasked', () => {
  const r = rig(() => [W(1), W(2)], ['acme/widgets#1']);
  r.tick(0);
  addToList(listPath(r.statusDir), { key: 'acme/widgets#2', source: 'manual' }, T0 + MIN);
  assert.match(r.tick(MIN).join(), /acme\/widgets#2/);
  assert.ok(!r.tick(2 * MIN).join().includes('#1'), 'PR 1 was adopted silently and is not repeated');
  const own = rig(() => [W(1)], []);
  assert.deepEqual(own.tick(0), []);
  assert.deepEqual(own.tick(MIN), []);
  assert.equal(own.log.includes('listed'), false, 'an empty list reads nothing by key');
  assert.equal(own.log.includes('search'), false, 'and there is no teammate search at all');
});

test('with no minutes configured pr-watch reads no listed PR', () => {
  const log: string[] = [];
  const statusDir = mkdtempSync(join(tmpdir(), 'pr-watch-list-'));
  addToList(listPath(statusDir), { key: 'acme/widgets#1', source: 'manual' }, T0);
  const run: Run = (_c, args) => { log.push(args.join(' ')); return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } }) }; };
  prWatch.check('open-prs', { run, now: T0, config: { ghLogin: 'me', selfReviewRepos: [], teammateMinutes: 0, statusDir } });
  assert.equal(log.some((l) => l.includes('repository(owner:') || l.includes('draft:false')), false);
});

test('a hands-off repo is not reviewed unless the user is a requested reviewer or the owner wrote it; every other repo is open to review', () => {
  const o = { ...O, guard: { globs: ['*/guarded'], login: 'owner-fake' } };
  const guarded = { repository: { nameWithOwner: 'acme/guarded' } };
  assert.equal(selectWaiting([node(guarded)], o).length, 0);
  assert.equal(selectWaiting([node({ ...guarded, reviewRequests: { nodes: [{ requestedReviewer: { login: 'someone-else' } }] } })], o).length, 0);
  assert.equal(selectWaiting([node({ ...guarded, reviewRequests: { nodes: [{ requestedReviewer: { login: 'ME' } }] } })], o).length, 1);
  assert.equal(selectWaiting([node({ ...guarded, author: { login: 'Owner-Fake', __typename: 'User' } })], o).length, 1, 'the owner\'s own PRs there are in scope');
  assert.equal(selectWaiting([node()], o).length, 1, 'a repo where the user was not asked is still reviewed');
  assert.equal(selectWaiting([node(guarded)], O).length, 1, 'with nothing configured nothing is hands off');
});

test('a former teammate\'s ready PR is never selected for a review wait', () => {
  const gone = node({ author: { login: 'Gone-Fake', __typename: 'User' } });
  assert.equal(selectWaiting([gone], O).length, 1, 'selected when not listed as former');
  assert.equal(selectWaiting([gone], { ...O, former: ['gone-fake'] }).length, 0);
  assert.equal(selectWaiting([node()], { ...O, former: ['gone-fake'] }).length, 1, 'other authors are untouched');
});

test('a PR the person ignored at its current head is not selected; a new head selects it again', () => {
  const head = 'a'.repeat(40);
  assert.equal(selectWaiting([node()], { ...O, ignored: new Map([['acme/widgets#12', head]]) }).length, 0);
  assert.equal(selectWaiting([node()], { ...O, ignored: new Map([['acme/widgets#12', 'b'.repeat(40)]]) }).length, 1, 'ignored at an older head');
  assert.equal(selectWaiting([node()], { ...O, ignored: new Map([['acme/other#12', head]]) }).length, 1, 'another PR\'s ignore does not apply');
});

test('"Review anyway" at the current head selects a hands-off PR at once, with no wait; at an older head it does not', () => {
  const head = 'a'.repeat(40);
  const o = { ...O, guard: { globs: ['*/guarded'], login: 'owner-fake' } };
  const fresh = node({ repository: { nameWithOwner: 'acme/guarded' }, createdAt: new Date(T0 - 2 * MIN).toISOString() });
  assert.equal(selectWaiting([fresh], o).length, 0);
  assert.equal(selectWaiting([fresh], { ...o, requested: new Map([['acme/guarded#12', head]]) }).length, 1);
  assert.equal(selectWaiting([fresh], { ...o, requested: new Map([['acme/guarded#12', 'b'.repeat(40)]]) }).length, 0);
  assert.equal(selectWaiting([node({ ...fresh, reviewDecision: 'APPROVED' })], { ...o, requested: new Map([['acme/guarded#12', head]]) }).length, 0, 'a decided PR is still skipped');
});

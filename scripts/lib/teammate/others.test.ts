// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/others.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../types.ts';
import { dropGate } from './others-drop.ts';
import { addToList, dropFromList, listPath, readList } from './others-list.ts';
import { discoverySearches, judgeNode, OTHERS_CACHE, PR_SELECTION, readOthersCache, reduceOthers, refreshOthers, specialKind, writeOthersCache } from './others.ts';
import type { OtherPr, OthersScope } from './others.ts';

const GATE = dropGate('America/New_York', { openHours: 72, activeHours: 48, dropDays: 2 });
const SCOPE: OthersScope = { owners: ['acme'], selfRepos: ['acme/solo'], self: 'me-fake', gate: GATE };

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 1, title: 't', url: 'https://github.com/acme/app/pull/1', isDraft: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
  baseRefName: 'develop', headRefName: 'feat/x', reviewDecision: null, author: { login: 'pat-fake', __typename: 'User' }, repository: { nameWithOwner: 'acme/app' },
  reviewRequests: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});
const stored = (over: Partial<OtherPr> = {}): OtherPr => ({ repo: 'acme/app', number: 1, title: 't', url: 'u', author: 'pat-fake', base: 'develop', head: 'h', createdAt: 'c', updatedAt: 'u', requested: [], decision: null, unresolved: 0, copilotThreads: 0, ...over });
const dir = (): string => mkdtempSync(join(tmpdir(), 'others-test-'));

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
    reviews: { nodes: [{ author: me, state: 'COMMENTED', submittedAt: '2026-10-02T00:00:00Z' }, { author: me, state: 'PENDING', submittedAt: '2026-10-04T00:00:00Z' }, { author: { login: 'kim-fake' }, state: 'DISMISSED', submittedAt: '2026-10-05T00:00:00Z' }] },
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

test('an approved PR is left out: by its decision, or by an approving review from anyone', () => {
  const approving = { reviews: { nodes: [{ author: { login: 'kim-fake' }, state: 'APPROVED', submittedAt: '2026-10-15T00:00:00Z' }] } };
  const out = reduceOthers([node({ number: 1 }), node({ number: 2, reviewDecision: 'APPROVED' }), node({ number: 3, ...approving }), node({ number: 4, reviews: { nodes: [{ author: { login: 'kim-fake' }, state: 'COMMENTED', submittedAt: '2026-10-15T00:00:00Z' }] } })] as never, SCOPE);
  assert.deepEqual(out.map((p) => p.number).sort(), [1, 4]);
});

const rv = (login: string, state: string, submittedAt: string, bodyText = '', typename = 'User'): unknown => ({ author: { login, __typename: typename }, state, submittedAt, bodyText });


test('a PR another person already reviewed (a verdict, or a comment with a body) leaves the tab; a bodiless comment, a bot and the author do not', () => {
  const out = reduceOthers([
    node({ number: 1 }),
    node({ number: 2, reviews: { nodes: [rv('kim-fake', 'CHANGES_REQUESTED', '2026-10-03T00:00:00Z')] } }),
    node({ number: 3, reviews: { nodes: [rv('kim-fake', 'COMMENTED', '2026-10-03T00:00:00Z', 'Please split this.')] } }),
    node({ number: 4, reviews: { nodes: [rv('kim-fake', 'COMMENTED', '2026-10-03T00:00:00Z', '')] } }),
    node({ number: 5, reviews: { nodes: [rv('copilot-pull-request-reviewer', 'COMMENTED', '2026-10-03T00:00:00Z', 'Looks fine', 'Bot')] } }),
    node({ number: 6, reviews: { nodes: [rv('pat-fake', 'COMMENTED', '2026-10-03T00:00:00Z', 'Replying.')] } }),
  ] as never, SCOPE);
  assert.deepEqual(out.map((p) => p.number).sort(), [1, 4, 5, 6]);
});

test('you were asked and have not reviewed: it stays when someone else commented, and goes once you have reviewed', () => {
  const kim = rv('kim-fake', 'COMMENTED', '2026-10-03T00:00:00Z', 'My take.');
  const asked = { reviewRequests: { nodes: [{ requestedReviewer: { login: 'ME-fake' } }] } };
  const out = reduceOthers([
    node({ number: 1, ...asked, reviews: { nodes: [kim] } }),
    node({ number: 2, ...asked, reviews: { nodes: [kim, rv('me-fake', 'COMMENTED', '2026-10-04T00:00:00Z', 'Mine.')] } }),
  ] as never, SCOPE);
  assert.deepEqual(out.map((p) => p.number), [1]);
});

test('an approval at the head leaves the tab, and a push after it with the reviewer asked again brings the card back', () => {
  const approved = rv('kim-fake', 'APPROVED', '2026-10-03T00:00:00Z');
  const head = (committedDate: string): Record<string, unknown> => ({ commits: { nodes: [{ commit: { committedDate } }] } });
  const out = reduceOthers([
    node({ number: 1, reviews: { nodes: [approved] }, ...head('2026-10-02T00:00:00Z') }),
    node({ number: 2, reviews: { nodes: [approved] }, ...head('2026-10-04T00:00:00Z'), reviewRequests: { nodes: [{ requestedReviewer: { login: 'kim-fake' } }] } }),
  ] as never, SCOPE);
  assert.deepEqual(out.map((p) => p.number), [2]);
});

// ---- the opt-in list: joins, reads and drops ----

const NOW = new Date('2026-10-21T15:00:00Z'); // Wednesday 11:00 ET
const KEY = 'acme/app#1';
const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const hit = (number: number, over: Record<string, unknown> = {}): Record<string, unknown> => node({ number, url: `https://github.com/acme/app/pull/${number}`, createdAt: ago(10), updatedAt: ago(0.1), commits: { nodes: [{ commit: { committedDate: ago(0.5) } }] }, ...over });
const asked = { reviewRequests: { nodes: [{ requestedReviewer: { login: 'me-fake' } }] } };

interface World { byKey?: Record<string, unknown>; found?: Partial<Record<'review-requested' | 'mentions' | 'staging' | 'label', unknown[]>>; failSearch?: string; failReads?: boolean }
/** A fake gh: search queries are answered by which qualifier they carry, by-key reads from `byKey`; every call is recorded. */
function fakeGh(w: World): { run: Run; queries: string[]; read: string[] } {
  const queries: string[] = [];
  const read: string[] = [];
  const run: Run = (_cmd, args) => {
    const q = args.find((a) => a.startsWith('query=')) ?? '';
    queries.push(q);
    if (q.includes('search(')) {
      const kind = (['review-requested', 'mentions', 'staging', 'label'] as const).find((k) => q.includes({ 'review-requested': 'review-requested:@me', mentions: 'mentions:@me', staging: 'base:staging', label: 'label:p0,hotfix' }[k]));
      if (w.failSearch && kind === w.failSearch) return { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
      return { status: 0, stderr: '', stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false }, nodes: kind ? w.found?.[kind] ?? [] : [] } } }) };
    }
    if (w.failReads) return { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
    const data: Record<string, unknown> = {};
    for (const m of q.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) {
      const key = `${m[2]}/${m[3]}#${m[4]}`.toLowerCase();
      read.push(key);
      data[m[1] as string] = { pullRequest: w.byKey?.[key] ?? null };
    }
    return { status: 0, stderr: '', stdout: JSON.stringify({ data }) };
  };
  return { run, queries, read };
}
const found = (number: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ number, url: `https://github.com/acme/app/pull/${number}`, updatedAt: ago(0.1), headRefName: 'feat/x', baseRefName: 'develop', author: { login: 'pat-fake', __typename: 'User' }, repository: { nameWithOwner: 'acme/app' }, labels: { nodes: [] }, ...over });
const fresh = (): { d: string; file: string } => { const d = dir(); return { d, file: listPath(d) }; };
const shown = (d: string): number[] => (readOthersCache(d)?.prs ?? []).map((p) => p.number).sort((a, b) => a - b);

test('only listed PRs are read, by key; PRs nobody asked about are never queried', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime());
  const g = fakeGh({ byKey: { [KEY]: hit(1, asked), 'acme/app#2': hit(2, asked) } });
  const out = refreshOthers(d, SCOPE, NOW, g.run);
  assert.deepEqual(g.read, [KEY]);
  assert.deepEqual(out.prs.map((p) => p.number), [1]);
});

test('no query reads every open PR: each search carries one narrow qualifier, and the rest are reads by key', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime());
  const g = fakeGh({ byKey: { [KEY]: hit(1) } });
  refreshOthers(d, SCOPE, NOW, g.run);
  const searches = g.queries.filter((q) => q.includes('search('));
  assert.equal(searches.length, 4);
  for (const q of searches) assert.match(q, /review-requested:@me|mentions:@me|base:staging|label:p0,hotfix/);
  assert.deepEqual(discoverySearches([]), [], 'no owner, no search');
  assert.deepEqual(discoverySearches(['bad owner', 'x;y']), []);
  assert.ok(g.queries.filter((q) => !q.includes('search(')).every((q) => /pullRequest\(number: \d+\)/.test(q)));
});

test('a GitHub review request, an @-mention, a staging twin, a backmerge and a P0 PR join the list; a PR that is none of them does not', () => {
  const { d, file } = fresh();
  const byKey = Object.fromEntries([11, 12, 13, 14, 15, 16, 17].map((n) => [`acme/app#${n}`, hit(n, asked)]));
  const g = fakeGh({ byKey, found: {
    'review-requested': [found(11)], mentions: [found(12)],
    staging: [found(13, { baseRefName: 'staging', headRefName: 'feat/x' }), found(14, { baseRefName: 'staging', headRefName: 'backmerge/main-to-staging' }), found(16, { baseRefName: 'staging', headRefName: 'release/2026-10' })],
    label: [found(15, { labels: { nodes: [{ name: 'P0' }] } }), found(17, { headRefName: 'feat/y', labels: { nodes: [{ name: 'hotfix' }] } })],
  } });
  refreshOthers(d, SCOPE, NOW, g.run);
  const s = readList(file);
  assert.deepEqual([...s.active.values()].map((e) => [e.key, e.source]).sort(), [['acme/app#11', 'review-request'], ['acme/app#12', 'mention'], ['acme/app#13', 'twin'], ['acme/app#14', 'backmerge'], ['acme/app#15', 'hotfix'], ['acme/app#17', 'hotfix']]);
  assert.ok(!s.active.has('acme/app#16'), 'a release PR into staging is not a twin');
});

test('specialKind reads branches and labels', () => {
  assert.equal(specialKind({ headRefName: 'back-merge-main', baseRefName: 'develop' }), 'backmerge');
  assert.equal(specialKind({ headRefName: 'hotfix/db-lock', baseRefName: 'main' }), 'hotfix');
  assert.equal(specialKind({ headRefName: 'feat/x', baseRefName: 'staging' }), 'twin');
  assert.equal(specialKind({ headRefName: 'feat/x', baseRefName: 'develop' }), null);
  assert.equal(specialKind({ headRefName: 'develop', baseRefName: 'staging' }), null);
});

test('discovery skips your own PRs, bots, self-review repos, former teammates and other owners', () => {
  const { d, file } = fresh();
  const g = fakeGh({ byKey: { 'acme/app#26': hit(26) }, found: { 'review-requested': [
    found(21, { author: { login: 'ME-fake', __typename: 'User' } }), found(22, { author: { login: 'dependabot[bot]', __typename: 'Bot' } }), found(23, { repository: { nameWithOwner: 'acme/solo' } }),
    found(24, { author: { login: 'gone-fake', __typename: 'User' } }), found(25, { repository: { nameWithOwner: 'other/app' } }), found(26),
  ] } });
  refreshOthers(d, { ...SCOPE, former: ['gone-fake'] }, NOW, g.run);
  assert.deepEqual([...readList(file).active.keys()], ['acme/app#26']);
});

test('judging: merged, closed, approved and picked-up PRs drop with the reason; an open one is kept', () => {
  const j = (over: Record<string, unknown>): string => { const r = judgeNode(hit(1, over) as never, SCOPE, { now: NOW.getTime() }); return 'drop' in r ? r.drop : 'pr' in r ? 'kept' : 'skip'; };
  assert.match(j({ state: 'MERGED' }), /merged/);
  assert.match(j({ state: 'CLOSED' }), /closed/);
  assert.match(j({ reviewDecision: 'APPROVED' }), /approved/);
  assert.match(j({ reviews: { nodes: [rv('kim-fake', 'CHANGES_REQUESTED', ago(1))] } }), /already reviewed/);
  assert.equal(j({ state: 'OPEN' }), 'kept');
  assert.match(j({ author: { login: 'ME-fake', __typename: 'User' } }), /not yours/);
});

test('the quiet drop counts working days: quiet since Friday is kept on Tuesday and dropped by Wednesday; a Slack-less manual add follows the same rule', () => {
  const quiet = (updatedAt: string, now: string): boolean => {
    const { d, file } = fresh();
    addToList(file, { key: KEY, source: 'manual' }, Date.parse('2026-10-14T12:00:00Z'));
    refreshOthers(d, SCOPE, new Date(now), fakeGh({ byKey: { [KEY]: hit(1, { createdAt: '2026-10-01T00:00:00Z', updatedAt, commits: { nodes: [{ commit: { committedDate: updatedAt } }] } }) } }).run);
    return readList(file).dropped.has(KEY);
  };
  assert.equal(quiet('2026-10-16T20:00:00Z', '2026-10-20T12:00:00Z'), false, 'Friday 16:00 ET to Tuesday 08:00 ET');
  assert.equal(quiet('2026-10-16T20:00:00Z', '2026-10-21T15:00:00Z'), true, 'to Wednesday 11:00 ET');
  assert.equal(quiet('2026-10-19T14:00:00Z', '2026-10-21T13:00:00Z'), false, 'Monday 10:00 ET to Wednesday 09:00 ET');
});

test('listing a PR is itself a sign of life: a hand-added old PR is not dropped the moment it is added', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime() - 3_600_000);
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: hit(1, { createdAt: ago(30), updatedAt: ago(20), commits: { nodes: [{ commit: { committedDate: ago(20) } }] } }) } }).run);
  assert.deepEqual(shown(d), [1]);
});

test('merged, approved and picked-up PRs leave the list, not only the cache', () => {
  const { d, file } = fresh();
  for (const n of [1, 2, 3, 4]) addToList(file, { key: `acme/app#${n}`, source: 'manual' }, NOW.getTime());
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { 'acme/app#1': hit(1, { state: 'MERGED' }), 'acme/app#2': hit(2, { reviewDecision: 'APPROVED' }), 'acme/app#3': hit(3, { reviews: { nodes: [rv('kim-fake', 'APPROVED', ago(0.2))] } }), 'acme/app#4': hit(4) } }).run);
  assert.deepEqual([...readList(file).active.keys()], ['acme/app#4']);
  assert.deepEqual([...readList(file).dropped.keys()].sort(), ['acme/app#1', 'acme/app#2', 'acme/app#3']);
  assert.deepEqual(shown(d), [4]);
});

test('you were asked and a teammate reviewed first: it stays; a teammate review before our review settles nothing once we have reviewed', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'review-request' }, NOW.getTime());
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: hit(1, { ...asked, reviews: { nodes: [rv('kim-fake', 'COMMENTED', ago(1), 'My take.')] } }) } }).run);
  assert.deepEqual(shown(d), [1]);
});

test('after our review the PR waits on the author: kept however quiet, and dropped once the author pushes and goes quiet again', () => {
  const mine = rv('me-fake', 'COMMENTED', '2026-10-09T15:00:00Z', 'Two thoughts.');
  const base = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-09T15:00:00Z', reviews: { nodes: [mine] } };
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'review-request' }, Date.parse('2026-10-08T12:00:00Z'));
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: hit(1, { ...base, commits: { nodes: [{ commit: { committedDate: '2026-10-09T10:00:00Z' } }] } }) } }).run);
  assert.deepEqual(shown(d), [1], 'twelve days quiet, but it is waiting on the author');
  const pushed = refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: hit(1, { ...base, updatedAt: '2026-10-12T15:00:00Z', commits: { nodes: [{ commit: { committedDate: '2026-10-12T15:00:00Z' } }] } }) } }).run);
  assert.deepEqual(pushed.prs, [], 'the author pushed on the 12th, nobody has looked since, and that is past two working days');
});

test('a dropped PR the discovery still sees comes back only when something happened to it', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'review-request' }, Date.parse('2026-10-10T12:00:00Z'));
  const quiet = hit(1, { ...asked, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-12T12:00:00Z', commits: { nodes: [{ commit: { committedDate: '2026-10-12T12:00:00Z' } }] } });
  const same = { 'review-requested': [found(1, { updatedAt: '2026-10-12T12:00:00Z' })] };
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: quiet }, found: same }).run);
  assert.equal(readList(file).dropped.has(KEY), true);
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: quiet }, found: same }).run);
  assert.equal(readList(file).active.size, 0, 'still review-requested on GitHub, but nothing new: stays off');
  const pushed = hit(1, { ...asked, createdAt: '2026-10-01T00:00:00Z', updatedAt: ago(0.1) });
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: pushed }, found: { 'review-requested': [found(1, { updatedAt: ago(0.1) })] } }).run);
  assert.deepEqual(shown(d), [1], 'a push or re-request moved updatedAt');
});

test('a PR GitHub no longer shows is dropped from the list', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime());
  refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: {} }).run);
  assert.equal(readList(file).dropped.get(KEY)?.why, 'GitHub no longer shows this PR');
});

test('a failed read keeps the listed PR and its last card, says why, and leaves the fetch time', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime());
  const first = new Date('2026-10-21T14:00:00Z');
  refreshOthers(d, SCOPE, first, fakeGh({ byKey: { [KEY]: hit(1) } }).run);
  const kept = refreshOthers(d, SCOPE, NOW, fakeGh({ failReads: true }).run);
  assert.deepEqual([kept.prs.map((p) => p.number), kept.fetchedAt?.toISOString(), /partial read: .*502/.test(kept.failure ?? '')], [[1], first.toISOString(), true]);
  assert.deepEqual([...readList(file).active.keys()], [KEY]);
});

test('a failed discovery search costs only that search: the listed PRs are still read and the failure is noted', () => {
  const { d, file } = fresh();
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime());
  const out = refreshOthers(d, SCOPE, NOW, fakeGh({ byKey: { [KEY]: hit(1) }, failSearch: 'mentions' }).run);
  assert.deepEqual(out.prs.map((p) => p.number), [1]);
  assert.equal(out.fetchedAt?.toISOString(), NOW.toISOString());
  assert.match(out.failure ?? '', /discovery: .*502/);
});

test('an empty list reads nothing and shows nothing', () => {
  const d = dir();
  const g = fakeGh({});
  const out = refreshOthers(d, SCOPE, NOW, g.run);
  assert.deepEqual([out.prs, g.read], [[], []]);
});

test('migration: a missing list is seeded once from the PRs with a draft waiting, and never again', () => {
  const { d, file } = fresh();
  const g = () => fakeGh({ byKey: { [KEY]: hit(1) } });
  refreshOthers(d, { ...SCOPE, seedKeys: [KEY, 'not a key', 'stranger-fake/x#1'] }, NOW, g().run);
  assert.deepEqual([...readList(file).active.values()].map((e) => [e.key, e.source]), [[KEY, 'seed']], 'a key outside the review owners is not seeded');
  dropFromList(file, KEY, 'merged');
  refreshOthers(d, { ...SCOPE, seedKeys: [KEY] }, NOW, g().run);
  assert.equal(readList(file).active.size, 0, 'a list that exists is not re-seeded');
});

test('PR_SELECTION reads review bodies, thread authors and the PR state the drop rules need', () => {
  assert.match(PR_SELECTION, /reviews\(last: 30\) \{ nodes \{ author \{ login __typename \} state submittedAt bodyText \} \}/);
  assert.match(PR_SELECTION, /\bstate\b/);
  assert.match(PR_SELECTION, /reviewThreads\(first: 100\) \{ nodes \{ isResolved comments\(first: 1\)/);
});

// ---- Slack ----

const slackDir = (...lines: string[]): string => { const sd = mkdtempSync(join(tmpdir(), 'slack-')); writeFileSync(join(sd, 'engineering.md'), `# e\n\n${lines.join('\n')}\n`); return sd; };
const URL1 = 'https://github.com/acme/app/pull/1';

test('a review ask in a watched Slack channel puts the PR on the list, with the channel, poster and time but no text', () => {
  const { d, file } = fresh();
  const sd = slackDir(`- 2026-10-21 09:00 ET **Frodo Fake**: can someone review ${URL1}? urgent for the demo`);
  refreshOthers(d, { ...SCOPE, slackDir: sd }, NOW, fakeGh({ byKey: { [KEY]: hit(1) } }).run);
  const e = readList(file).active.get(KEY);
  assert.deepEqual([e?.source, e?.channel, e?.author, e?.at], ['slack', 'engineering', 'Frodo Fake', Date.parse('2026-10-21T13:00:00Z')]);
  assert.ok(!JSON.stringify(readFileSync(file, 'utf8')).includes('demo'));
  assert.deepEqual(shown(d), [1]);
});

test('an old Slack ask is not listed; a new ask after a drop brings the PR back', () => {
  const { d, file } = fresh();
  refreshOthers(d, { ...SCOPE, slackDir: slackDir(`- 2026-10-05 09:00 ET **Frodo Fake**: PTAL ${URL1}`) }, NOW, fakeGh({ byKey: { [KEY]: hit(1) } }).run);
  assert.equal(readList(file).active.size, 0, 'asked more than two working days ago');
  addToList(file, { key: KEY, source: 'manual' }, NOW.getTime() - 7_200_000);
  dropFromList(file, KEY, 'merged', undefined, NOW.getTime() - 3_600_000);
  refreshOthers(d, { ...SCOPE, slackDir: slackDir(`- 2026-10-21 10:30 ET **Frodo Fake**: still need eyes, PTAL ${URL1}`) }, NOW, fakeGh({ byKey: { [KEY]: hit(1) } }).run);
  assert.equal(readList(file).active.has(KEY), true);
});

test('a teammate claiming the PR in the thread drops it, unless you were asked and have not reviewed', () => {
  const sd = slackDir(`- 2026-10-21 09:00 ET **Frodo Fake**: PTAL ${URL1}`, '- 2026-10-21 09:20 ET ↳ **Samwise Fake**: I\'ll take it');
  const a = fresh();
  refreshOthers(a.d, { ...SCOPE, slackDir: sd, selfNames: ['Pip Fake'] }, NOW, fakeGh({ byKey: { [KEY]: hit(1) } }).run);
  assert.equal(readList(a.file).dropped.get(KEY)?.why, 'a teammate claimed it in Slack');
  const b = fresh();
  refreshOthers(b.d, { ...SCOPE, slackDir: sd, selfNames: ['Pip Fake'] }, NOW, fakeGh({ byKey: { [KEY]: hit(1, asked) } }).run);
  assert.deepEqual(shown(b.d), [1]);
  const c = fresh();
  refreshOthers(c.d, { ...SCOPE, slackDir: sd, selfNames: ['Samwise Fake'] }, NOW, fakeGh({ byKey: { [KEY]: hit(1) } }).run);
  assert.deepEqual(shown(c.d), [1], 'a reply by you is not a claim');
});

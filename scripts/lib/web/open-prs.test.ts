// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/open-prs.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenPrs } from './open-prs.ts';
import type { PodiumState, PrCard } from './state.ts';
import type { PageConfig } from '../status-page/render.ts';

const NOW = new Date('2026-10-06T15:00:00Z');
const PAGE: PageConfig = {
  streams: [], repoStreams: {}, vaultName: '', trackerUrlBase: 'https://tracker.test/browse/', ticketNotePath: '', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC',
};
const card = (repo: string, number: number, over: Partial<PrCard> = {}): PrCard => ({
  repo, short: repo.split('/')[1] ?? repo, number, title: `thing ${number}`, url: `https://example.test/${repo}/pull/${number}`, stream: 's', base: 'develop', head: `feat/b${number}`,
  isDraft: false, ci: 'SUCCESS', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', unresolved: 0, review: null, flags: [], ...over,
});
const state = (prs: PrCard[], prData: PodiumState['prData'] = { fetchedAt: '2026-10-06T14:55:00.000Z', stale: false }): PodiumState => ({ prData, prs }) as PodiumState;

test('repos are grouped, the self-review group comes last, and repos run by count then name', () => {
  const out = buildOpenPrs(state([
    card('org/zeta', 1), card('org/alpha', 2), card('org/alpha', 3), card('org/beta', 4), card('me/solo', 5, { selfReview: true }),
  ]), PAGE, NOW);
  assert.deepEqual(out.groups.map((g) => [g.id, g.count]), [['team', 4], ['self-review', 1]]);
  assert.deepEqual(out.groups[0]?.repos.map((r) => [r.repo, r.count]), [['org/alpha', 2], ['org/beta', 1], ['org/zeta', 1]]);
  assert.equal(out.total, 5);
});

test('a group with no PRs is left out, and no PRs at all gives no groups', () => {
  assert.deepEqual(buildOpenPrs(state([card('org/a', 1)]), PAGE, NOW).groups.map((g) => g.id), ['team']);
  assert.deepEqual(buildOpenPrs(state([]), PAGE, NOW).groups, []);
});

test('a row carries review, threads, mergeable, draft, base, age and the ticket key from the title or branch', () => {
  const out = buildOpenPrs(state([
    card('org/a', 7, { title: 'fix: leak FAKE-12', review: 'CHANGES_REQUESTED', unresolved: 3, mergeable: 'CONFLICTING', isDraft: true, base: 'staging', createdAt: '2026-10-03T14:00:00Z' }),
    card('org/a', 8, { head: 'feat/FAKE-9-x', review: 'APPROVED', mergeable: 'UNKNOWN' }),
    card('org/a', 9, { review: 'REVIEW_REQUIRED' }),
  ]), PAGE, NOW);
  const [a, b, c] = out.groups[0]?.repos[0]?.prs ?? [];
  assert.deepEqual([a?.review, a?.unresolved, a?.mergeable, a?.isDraft, a?.base, a?.ageDays], ['changes-requested', 3, 'conflicting', true, 'staging', 3]);
  assert.deepEqual(a?.ticket, { label: 'FAKE-12', url: 'https://tracker.test/browse/FAKE-12' });
  assert.deepEqual([b?.review, b?.mergeable, b?.ticket?.label, b?.ageDays], ['approved', 'unknown', 'FAKE-9', undefined]);
  assert.deepEqual([c?.review, c?.ticket], ['none', undefined]);
});

test('twin PRs on one head branch sit side by side and name each other; a staging twin names its develop PR', () => {
  const out = buildOpenPrs(state([
    card('org/a', 30, { head: 'feat/x' }), card('org/a', 10, { head: 'feat/y' }), card('org/a', 31, { head: 'feat/x', base: 'staging' }),
    card('org/a', 40, { head: 'feat/z-staging', base: 'staging', twinOf: 10 }),
  ]), PAGE, NOW);
  const rows = out.groups[0]?.repos[0]?.prs ?? [];
  assert.deepEqual(rows.map((r) => r.number), [10, 40, 30, 31]);
  assert.deepEqual(rows.map((r) => r.twins), [[40], [10], [31], [30]]);
  assert.deepEqual(rows.map((r) => [r.sides?.develop?.number, r.sides?.staging?.number]), [[10, 40], [10, 40], [30, 31], [30, 31]]);
});

test('a develop PR with no staging twin names the gap, and a PR into main is not a pair', () => {
  const out = buildOpenPrs(state([
    card('org/a', 2, { base: 'develop' }),
    card('org/a', 3, { base: 'main', head: 'feat/other' }),
  ]), PAGE, NOW);
  const rows = out.groups[0]?.repos[0]?.prs ?? [];
  assert.deepEqual(rows.find((r) => r.number === 2)?.sides, { develop: { number: 2, url: 'https://example.test/org/a/pull/2' } });
  assert.equal(rows.find((r) => r.number === 3)?.sides, undefined);
});

test('a row copies CI and the stack parent, and omits a blank CI', () => {
  const out = buildOpenPrs(state([
    card('org/a', 1, { ci: 'FAILURE', stackedOn: 9 }),
    card('org/a', 2, { ci: '' }),
  ]), PAGE, NOW);
  const rows = out.groups[0]?.repos[0]?.prs ?? [];
  assert.equal(rows.find((r) => r.number === 1)?.ci, 'FAILURE');
  assert.equal(rows.find((r) => r.number === 1)?.stackedOn, 9);
  assert.equal(rows.find((r) => r.number === 2)?.ci, undefined);
  assert.equal(rows.find((r) => r.number === 2)?.stackedOn, undefined);
});

test('the PR data age and a failed read are passed through; a missing or unreadable createdAt gives no age', () => {
  const out = buildOpenPrs(state([card('org/a', 1, { createdAt: 'not a date' })], { fetchedAt: null, stale: true, failure: 'gh read failed' }), PAGE, NOW);
  assert.deepEqual(out.prData, { fetchedAt: null, stale: true, failure: 'gh read failed' });
  assert.equal(out.groups[0]?.repos[0]?.prs[0]?.ageDays, undefined);
});

test('reviewOf: history decides when it is read, and an empty decision is never an approval', async () => {
  const { reviewOf } = await import('./open-prs.ts');
  assert.equal(reviewOf(null, ['fake-a'], []), 'approved');
  assert.equal(reviewOf('APPROVED', [], []), 'none', 'history without an approver wins over a stale decision');
  assert.equal(reviewOf('', [], undefined), 'none');
  assert.equal(reviewOf('APPROVED', ['fake-a'], ['fake-b']), 'changes-requested');
  assert.equal(reviewOf('CHANGES_REQUESTED', ['fake-a'], []), 'changes-requested');
  assert.equal(reviewOf('APPROVED'), 'approved', 'no history: GitHub decision stands');
  assert.equal(reviewOf(null), 'none');
  assert.equal(reviewOf('REVIEW_REQUIRED', ['fake-a'], []), 'none', 'GitHub still wants more reviews');
});

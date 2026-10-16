// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/others-prs.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOthersPrs } from './others-prs.ts';
import { etMs } from './slack-activity.ts';
import { writeOthersCache } from '../teammate/others.ts';
import type { OtherPr } from '../teammate/others.ts';

const NOW = new Date('2026-10-15T12:10:00Z');
const pr = (n: number, over: Partial<OtherPr> = {}): OtherPr => ({ repo: 'acme/app', number: n, title: `t${n}`, url: `https://github.com/acme/app/pull/${n}`, author: 'pat-fake', base: 'develop', head: 'h', createdAt: '2026-10-12T12:10:00Z', updatedAt: `2026-10-15T0${n}:00:00Z`, requested: [], decision: null, unresolved: 0, copilotThreads: 0, ...over });
const cacheWith = (prs: OtherPr[], fetchedAt: Date | null = new Date('2026-10-15T12:05:00Z'), failure?: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'others-web-'));
  writeOthersCache(d, { fetchedAt, prs, ...(failure ? { failure } : {}) });
  return d;
};
const opts = (statusDir: string) => ({ statusDir, owners: ['acme'], selfRepos: ['acme/solo'], self: 'Me-Fake' });

test('rows run newest activity first and carry the fields the tab shows', () => {
  const out = buildOthersPrs(opts(cacheWith([pr(1, { requested: ['me-fake'], decision: 'APPROVED' }), pr(3, { decision: 'CHANGES_REQUESTED', unresolved: 2, copilotThreads: 2 }), pr(2, { decision: 'REVIEW_REQUIRED' })])), NOW);
  assert.deepEqual(out.prs.map((p) => p.number), [3, 2, 1]);
  assert.deepEqual(out.prs.map((p) => p.review), ['changes-requested', 'review-required', 'approved']);
  assert.deepEqual(out.prs.map((p) => p.youAsked), [false, false, true]);
  assert.deepEqual([out.prs[0]?.unresolved, out.prs[0]?.copilotThreads, out.prs[0]?.ageDays, out.total], [2, 2, 3, 3]);
  assert.deepEqual(out.prData, { fetchedAt: '2026-10-15T12:05:00.000Z', stale: false });
});

test('the user\'s own PRs and self-review repos are filtered on read too, even when the cache holds them', () => {
  const out = buildOthersPrs(opts(cacheWith([pr(1), pr(2, { author: 'ME-FAKE' }), pr(3, { repo: 'acme/solo' }), pr(4, { repo: 'other/app' })])), NOW);
  assert.deepEqual(out.prs.map((p) => p.number), [1]);
});

test('no cache yet reads as an empty, stale list; a failed read and an old list are flagged', () => {
  const none = buildOthersPrs(opts(mkdtempSync(join(tmpdir(), 'others-web-'))), NOW);
  assert.deepEqual([none.total, none.prData], [0, { fetchedAt: null, stale: true }]);
  const old = buildOthersPrs(opts(cacheWith([pr(1)], new Date('2026-10-15T11:00:00Z'), 'rate limited')), NOW);
  assert.deepEqual(old.prData, { fetchedAt: '2026-10-15T11:00:00.000Z', stale: true, failure: 'rate limited' });
});

test('a hands-off repo\'s PR is listed and marked unless you were asked or its owner wrote it', () => {
  const o = { ...opts(cacheWith([pr(1, { repo: 'acme/guarded' }), pr(2, { repo: 'acme/guarded', requested: ['me-fake'] }), pr(3, { repo: 'acme/guarded', author: 'Owner-Fake' }), pr(4)])), guard: { globs: ['*/guarded'], login: 'owner-fake' } };
  const by = new Map(buildOthersPrs(o, NOW).prs.map((p) => [p.number, p]));
  assert.deepEqual([1, 2, 3, 4].map((n) => by.get(n)?.handsOff), [true, undefined, undefined, undefined]);
  assert.equal(buildOthersPrs({ ...o, guard: undefined }, NOW).prs.some((p) => p.handsOff), false, 'nothing configured, nothing marked');
});

const slackDir = (lines: string[]): string => {
  const d = mkdtempSync(join(tmpdir(), 'others-slack-'));
  writeFileSync(join(d, 'engineering.md'), `---\nslack_tag: "engineering"\n---\n\n${lines.join('\n')}\n`);
  return d;
};
const url = (n: number): string => `https://github.com/acme/app/pull/${n}`;
const gated = (prs: OtherPr[], lines: string[], extra: Record<string, unknown> = {}) => buildOthersPrs({ ...opts(cacheWith(prs)), slackDir: slackDir(lines), openHours: 72, activeHours: 48, dropDays: 3, ...extra }, NOW);
const staleOf = (out: ReturnType<typeof buildOthersPrs>): Record<number, boolean> => Object.fromEntries(out.prs.map((p) => [p.number, p.stale === true]));

const numbers = (out: ReturnType<typeof buildOthersPrs>): number[] => out.prs.map((p) => p.number).sort((a, b) => a - b);

test('Eastern times honour daylight saving', () => {
  assert.equal(new Date(etMs(2026, 10, 15, 8, 10)).toISOString(), '2026-10-15T12:10:00.000Z');
  assert.equal(new Date(etMs(2026, 12, 1, 8, 10)).toISOString(), '2026-12-01T13:10:00.000Z');
  assert.equal(new Date(etMs(2026, 3, 8, 3, 30)).toISOString(), '2026-03-08T07:30:00.000Z', 'just after the spring change');
  assert.equal(new Date(etMs(2026, 11, 1, 5, 0)).toISOString(), '2026-11-01T10:00:00.000Z', 'after the autumn change');
});

const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const old = (over: Partial<OtherPr> = {}): Partial<OtherPr> => ({ createdAt: hoursAgo(24 * 30), updatedAt: hoursAgo(24 * 30), ...over });

test('a PR opened inside 72 hours is never stale; at 72 hours it needs activity', () => {
  const out = gated([pr(1, { createdAt: hoursAgo(71.9), updatedAt: hoursAgo(60) }), pr(2, { createdAt: hoursAgo(72), updatedAt: hoursAgo(60) })], []);
  assert.deepEqual(staleOf(out), { 1: false, 2: true });
});

test('activity inside 48 hours keeps an older PR active; at 48 hours it is stale', () => {
  const out = gated([pr(1, old({ updatedAt: hoursAgo(47.9) })), pr(2, old({ updatedAt: hoursAgo(48) }))], []);
  assert.deepEqual([numbers(out), staleOf(out)], [[1, 2], { 1: false, 2: true }]);
});

test('no activity for more than three days drops the PR, Stale included; exactly three days stays, stale', () => {
  const out = gated([pr(1, old({ updatedAt: hoursAgo(72) })), pr(2, old({ updatedAt: hoursAgo(72.1) }))], []);
  assert.deepEqual([numbers(out), staleOf(out)[1]], [[1], true]);
});

test('a Slack post or reply carrying the link is activity: it brings an old PR back, and an old post does not', () => {
  const fresh = gated([pr(1, old())], [`- 2026-10-15 07:00 ET **Pat F**: ${url(1)}`]);
  assert.deepEqual([numbers(fresh), staleOf(fresh)[1]], [[1], false]);
  const reply = gated([pr(1, old())], [`- 2026-10-01 08:09 ET **Pat F**: ${url(1)}`, '- 2026-10-15 07:00 ET ↳ **Pat F**: still blocked on this']);
  assert.deepEqual([numbers(reply), staleOf(reply)[1]], [[1], false]);
  const post = gated([pr(1, old())], [`- 2026-10-13 08:09 ET **Pat F**: ${url(1)}`]);
  assert.deepEqual([numbers(post), staleOf(post)[1]], [[1], true]);
});

test('a request for you is not an exemption: an ancient PR you were asked on is dropped, an older one that is only quiet goes stale', () => {
  // The shape of a real one: opened 167 days ago, last touched 114 days ago, you were requested back then.
  const out = gated([pr(579, { createdAt: hoursAgo(24 * 167), updatedAt: hoursAgo(24 * 114), requested: ['me-fake'] }), pr(2, old({ updatedAt: hoursAgo(60), requested: ['me-fake'] }))], []);
  assert.deepEqual([numbers(out), staleOf(out)[2]], [[2], true]);
});

test('a PR never posted keeps its opening as the ask, and the stale reason is in hours under three days', () => {
  const out = gated([pr(1, old({ updatedAt: hoursAgo(60) }))], []);
  const row = out.prs[0]!;
  assert.equal(row.staleWhy, 'no activity for 60 h, opened 30 d ago');
  assert.equal(row.openedAt, hoursAgo(24 * 30));
  assert.equal(row.askedAt, hoursAgo(24 * 30));
});

test('with no gate configured nothing is stale or dropped', () => {
  const out = buildOthersPrs({ ...opts(cacheWith([pr(1, old())])) }, NOW);
  assert.deepEqual([numbers(out), staleOf(out)[1]], [[1], false]);
});

test('a non-draft PR nobody has asked about or reviewed is marked not asked until it is requested, reviewed or posted', () => {
  const base = { isDraft: false, reviewCount: 0 };
  const out = gated([pr(1, base), pr(2, { ...base, requested: ['kim-fake'] }), pr(3, { ...base, reviewCount: 1 }), pr(4, base), pr(5, { ...base, isDraft: true })], [`- 2026-10-15 07:00 ET **Pat F**: ${url(4)}`]);
  assert.deepEqual(out.prs.map((p) => [p.number, p.notAsked === true]).sort(), [[1, true], [2, false], [3, false], [4, false], [5, false]]);
});

test('checks, conflicts, block labels and a review the author has not pushed after are read from the cache', () => {
  const out = buildOthersPrs(opts(cacheWith([
    pr(1, { ci: 'FAILURE', mergeable: 'CONFLICTING', isDraft: false }), pr(2, { head: 'release/1.2', ci: 'PENDING' }), pr(3, { labels: ['Do Not Merge'] }),
    pr(4, { yourReview: { state: 'COMMENTED', at: '2026-10-14T10:00:00Z' }, headAt: '2026-10-14T09:00:00Z' }), pr(5, { yourReview: { state: 'COMMENTED', at: '2026-10-14T10:00:00Z' }, headAt: '2026-10-14T11:00:00Z' }),
    pr(6, { yourReview: { state: 'APPROVED', at: '2026-10-14T10:00:00Z' }, headAt: '2026-10-14T09:00:00Z' }),
  ])), NOW);
  const by = (n: number) => out.prs.find((p) => p.number === n);
  assert.deepEqual([by(1)?.ci, by(1)?.conflicting, by(2)?.block, by(2)?.ci, by(3)?.block], ['fail', true, 'release', 'pending', 'blocked']);
  assert.deepEqual([4, 5, 6].map((n) => by(n)?.awaitingAuthor === true), [true, false, false]);
});

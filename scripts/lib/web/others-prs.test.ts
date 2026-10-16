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
const gated = (prs: OtherPr[], lines: string[], extra: Record<string, unknown> = {}) => buildOthersPrs({ ...opts(cacheWith(prs)), slackDir: slackDir(lines), maxAgeDays: 2, ...extra }, NOW);
const staleOf = (out: ReturnType<typeof buildOthersPrs>): Record<number, boolean> => Object.fromEntries(out.prs.map((p) => [p.number, p.stale === true]));

test('Eastern times honour daylight saving', () => {
  assert.equal(new Date(etMs(2026, 10, 15, 8, 10)).toISOString(), '2026-10-15T12:10:00.000Z');
  assert.equal(new Date(etMs(2026, 12, 1, 8, 10)).toISOString(), '2026-12-01T13:10:00.000Z');
  assert.equal(new Date(etMs(2026, 3, 8, 3, 30)).toISOString(), '2026-03-08T07:30:00.000Z', 'just after the spring change');
  assert.equal(new Date(etMs(2026, 11, 1, 5, 0)).toISOString(), '2026-11-01T10:00:00.000Z', 'after the autumn change');
});

test('a Slack post three days old with a reply yesterday is not stale; with no reply it is, and says why', () => {
  const out = gated([pr(1), pr(2)], [
    `- 2026-10-12 09:00 ET **Pat F**: please review ${url(1)}`, '- 2026-10-14 15:00 ET ↳ **Kim F**: bump',
    `- 2026-10-12 09:00 ET **Pat F**: and this ${url(2)}`,
  ]);
  assert.deepEqual(staleOf(out), { 1: false, 2: true });
  assert.equal(out.prs.find((p) => p.number === 2)?.staleWhy, 'Slack post 3d, no reply');
  assert.equal(out.prs.find((p) => p.number === 1)?.askedAt, new Date(etMs(2026, 10, 14, 15, 0)).toISOString());
});

test('the cutoff is exact: an ask just inside two days stays, just past it goes stale; a re-up brings it back', () => {
  const inside = gated([pr(1)], [`- 2026-10-13 08:11 ET **Pat F**: ${url(1)}`]);
  const past = gated([pr(1)], [`- 2026-10-13 08:09 ET **Pat F**: ${url(1)}`]);
  assert.deepEqual([staleOf(inside)[1], staleOf(past)[1]], [false, true]);
  const reup = gated([pr(1)], [`- 2026-10-13 08:09 ET **Pat F**: ${url(1)}`, '- 2026-10-15 07:00 ET ↳ **Pat F**: still blocked on this']);
  assert.equal(staleOf(reup)[1], false);
});

test('a PR never posted ages from its opening; one you are asked on, or @-mentioned on, never goes stale', () => {
  const out = gated([
    pr(1, { createdAt: '2026-10-11T12:10:00Z' }), pr(2, { createdAt: '2026-10-11T12:10:00Z', requested: ['me-fake'] }), pr(3, { createdAt: '2026-10-14T12:10:00Z' }),
    pr(4, { createdAt: '2026-10-01T12:10:00Z' }),
  ], [`- 2026-10-10 09:00 ET **Pat F**: ${url(4)} ⏎ @Mina can you confirm`], { mentionNames: ['mina'] });
  assert.deepEqual(staleOf(out), { 1: true, 2: false, 3: false, 4: false });
  assert.equal(out.prs.find((p) => p.number === 1)?.staleWhy, 'never posted, opened 4d ago');
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

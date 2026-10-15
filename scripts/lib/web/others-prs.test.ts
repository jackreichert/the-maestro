// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/web/others-prs.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOthersPrs } from './others-prs.ts';
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

test('an arya-agentic PR is listed and marked hands off unless you were asked to review it', () => {
  const out = buildOthersPrs(opts(cacheWith([pr(1, { repo: 'acme/arya-agentic' }), pr(2, { repo: 'acme/arya-agentic', requested: ['me-fake'] }), pr(3)])), NOW);
  const by = new Map(out.prs.map((p) => [p.number, p]));
  assert.deepEqual([by.get(1)?.handsOff, by.get(2)?.handsOff, by.get(3)?.handsOff], [true, undefined, undefined]);
  assert.equal(out.total, 3);
});

// Run: node --test scripts/web/client/test/others-class.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUBTABS, classify } from '../src/others-class.ts';
import type { OthersPrRow } from '../src/types.ts';

const pr = (over: Partial<OthersPrRow> = {}): OthersPrRow => ({
  repo: 'acme/app', number: 1, title: 't', url: 'https://github.com/acme/app/pull/1', author: 'pat-fake', base: 'develop', updatedAt: '2026-10-15T00:00:00Z', youAsked: false,
  review: 'review-required', unresolved: 0, copilotThreads: 0, isDraft: false, ci: 'pass', conflicting: false, awaitingAuthor: false, ...over,
});
const tab = (over: Partial<OthersPrRow> = {}, draft = false): string => classify(pr(over), draft).tab;

test('a clean PR is ready for approval: not draft, checks green, mergeable, no threads, nothing of ours pending', () => {
  assert.deepEqual(classify(pr(), false), { tab: 'ready', reasons: [] });
  assert.equal(tab({ ci: 'none' }), 'ready', 'a repo with no checks is not held for them');
  assert.equal(tab({ review: 'approved' }), 'ready');
});

test('any unresolved thread, Copilot, bot or human, puts it in threads open, and it can never be ready', () => {
  assert.equal(tab({ unresolved: 2 }), 'threads');
  assert.equal(tab({ unresolved: 2, copilotThreads: 2 }), 'threads');
});

test('each blocker puts it in not ready, with its reason in words', () => {
  assert.deepEqual(classify(pr({ isDraft: true }), false), { tab: 'not-ready', reasons: ['Draft'] });
  assert.deepEqual(classify(pr({ ci: 'fail' }), false).reasons, ['Checks failing']);
  assert.deepEqual(classify(pr({ ci: 'pending' }), false).reasons, ['Checks pending']);
  assert.deepEqual(classify(pr({ conflicting: true }), false).reasons, ['Merge conflict']);
  assert.deepEqual(classify(pr({ review: 'changes-requested' }), false).reasons, ['Changes requested']);
  assert.deepEqual(classify(pr({ block: 'release' }), false).reasons, ['Release']);
  assert.deepEqual(classify(pr({ block: 'blocked' }), false).reasons, ['Blocked']);
  assert.deepEqual(classify(pr({ isDraft: true, ci: 'fail', conflicting: true }), false).reasons, ['Draft', 'Checks failing', 'Merge conflict']);
});

test('in review is a waiting draft of ours, or our review waiting for the author; an addressed review is back in the normal flow', () => {
  assert.equal(tab({}, true), 'in-review');
  assert.equal(tab({ awaitingAuthor: true }), 'in-review');
  assert.equal(tab({ awaitingAuthor: false }), 'ready', 'the author pushed after our review: a re-review, ready if clean');
});

test('precedence: in review, then threads open, then not ready, then ready', () => {
  assert.equal(tab({ unresolved: 1, ci: 'fail', isDraft: true }, true), 'in-review');
  assert.equal(tab({ unresolved: 1, ci: 'fail', awaitingAuthor: true }), 'in-review');
  assert.equal(tab({ unresolved: 1, ci: 'fail', isDraft: true }), 'threads');
  assert.equal(tab({ ci: 'fail', conflicting: true }), 'not-ready');
});

test('every PR lands in exactly one sub-tab, and the order and labels are fixed', () => {
  assert.deepEqual(SUBTABS.map((t) => t.id), ['ready', 'threads', 'not-ready', 'in-review', 'stale']);
  assert.deepEqual(SUBTABS.map((t) => t.label), ['Ready for approval', 'Threads open', 'Not ready', 'In review', 'Stale']);
  const all = [pr(), pr({ unresolved: 1 }), pr({ ci: 'fail' }), pr({ awaitingAuthor: true }), pr({ isDraft: true, unresolved: 3 })];
  const seen = all.map((p) => classify(p, false).tab);
  assert.ok(seen.every((t) => SUBTABS.some((s) => s.id === t)));
});

test('a row from an older server, with none of the new fields, is read as clean', () => {
  const old = { ...pr(), isDraft: undefined, ci: undefined, conflicting: undefined, awaitingAuthor: undefined, block: undefined } as unknown as OthersPrRow;
  assert.equal(classify(old, false).tab, 'ready');
});

test('a stale ask goes to the Stale gate first, whatever else is true, and comes back to its own tab once it is re-upped', () => {
  const old = { stale: true, staleWhy: 'Slack post 3d, no reply', unresolved: 2 };
  assert.deepEqual(classify(pr(old), false), { tab: 'stale', reasons: ['Slack post 3d, no reply'] });
  assert.equal(classify(pr({ ...old, awaitingAuthor: true }), true).tab, 'stale');
  assert.equal(tab({ unresolved: 2 }), 'threads', 'the same PR once the server stops marking it stale');
  assert.equal(SUBTABS.at(-1)?.id, 'stale');
  assert.equal(SUBTABS[0]?.id, 'ready');
});

test('a non-draft PR nobody has asked about goes to not ready as "Not asked yet"', () => {
  assert.deepEqual(classify(pr({ notAsked: true }), false), { tab: 'not-ready', reasons: ['Not asked yet'] });
  assert.deepEqual(classify(pr({ isDraft: true, notAsked: true }), false).reasons, ['Draft']);
});

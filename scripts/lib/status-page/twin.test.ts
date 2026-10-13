// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/status-page/twin.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchStem, findDevelopTwin, isStoredTwin, withDevelopTwins } from './twin.ts';
import type { RepoFlow } from './twin.ts';
import type { RawPr } from './generate.ts';

const raw = (number: number, repo: string, base: string, head: string): RawPr => ({
  number, title: `t${number}`, url: `https://example.test/${repo}/pull/${number}`, isDraft: false, baseRefName: base, headRefName: head,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: repo },
  reviewThreads: { nodes: [] }, commits: { nodes: [] },
});
const flow = (over: Partial<RepoFlow> = {}): RepoFlow => ({ hasDevelop: true, hasStaging: true, openDevelop: [], mergedDevelop: [], ...over });
const merged = (number: number, head: string) => ({ number, url: `https://example.test/pull/${number}`, head });

test('a head branch matches its twin when it is the same or differs only by a -staging or -develop suffix', () => {
  assert.equal(branchStem('fix/FAKE-1-leak-staging'), 'fix/FAKE-1-leak');
  assert.equal(branchStem('fix/FAKE-1-leak-develop'), 'fix/FAKE-1-leak');
  assert.equal(branchStem('fix/staging-notes'), 'fix/staging-notes', 'only a trailing suffix is stripped');
  const open = [{ number: 5, url: 'u5', head: 'fix/FAKE-1-leak-develop' }];
  assert.equal(findDevelopTwin('fix/FAKE-1-leak-staging', open, [])?.number, 5);
  assert.equal(findDevelopTwin('fix/FAKE-1-leak', open, [])?.number, 5);
  assert.equal(findDevelopTwin('fix/FAKE-1-leak-staging', [{ number: 6, url: 'u6', head: 'fix/FAKE-1-leak-staging' }], [])?.number, 6, 'the same branch name pairs too');
  assert.equal(findDevelopTwin('fix/FAKE-2-other-staging', open, []), undefined);
});

test('an open twin wins over a merged one, and a merged one is marked merged', () => {
  const open = [{ number: 9, url: 'u9', head: 'feat/x-develop' }];
  assert.deepEqual(findDevelopTwin('feat/x-staging', open, [merged(4, 'feat/x-develop')]), { number: 9, url: 'u9', merged: false });
  assert.deepEqual(findDevelopTwin('feat/x-staging', [], [merged(4, 'feat/x-develop')]), { number: 4, url: 'https://example.test/pull/4', merged: true });
});

test('twin unmerged: the staging PR is marked with the open develop twin (a staging and develop pair with suffixed branches)', () => {
  const prs = [raw(3970, 'o/widgets', 'staging', 'fix/FAKE-1-x-staging'), raw(3990, 'o/widgets', 'develop', 'fix/FAKE-1-x-develop')];
  const out = withDevelopTwins(prs, () => flow());
  assert.deepEqual(out[0]?.developTwin, { number: 3990, url: 'https://example.test/o/widgets/pull/3990', merged: false });
  assert.equal('developTwin' in (out[1] as object), false, 'the develop PR itself is untouched');
});

test('twin merged: the staging PR is marked with the merged twin, from the recent merged develop PRs', () => {
  const out = withDevelopTwins([raw(10, 'o/api', 'staging', 'feat/y')], () => flow({ mergedDevelop: [merged(8, 'feat/y-develop')] }));
  assert.equal(out[0]?.developTwin?.merged, true);
  assert.equal(out[0]?.developTwin?.number, 8);
});

test('no twin anywhere: the mark is null, not absent, so the page can say none was found', () => {
  const out = withDevelopTwins([raw(10, 'o/api', 'staging', 'feat/y')], () => flow({ mergedDevelop: [merged(8, 'feat/other')] }));
  assert.equal(out[0]?.developTwin, null);
});

test('a failed repo read marks its staging PRs as waiting, never as free', () => {
  assert.equal(withDevelopTwins([raw(1, 'o/api', 'staging', 'a')], () => undefined)[0]?.developTwin, null);
});

test('an open develop twin by another author wins over an older merged PR on the same branch', () => {
  const out = withDevelopTwins([raw(1, 'o/api', 'staging', 'feat/x-staging')], () => flow({ openDevelop: [{ number: 12, url: 'u12', head: 'feat/x-develop' }], mergedDevelop: [merged(4, 'feat/x-develop')] }));
  assert.deepEqual(out[0]?.developTwin, { number: 12, url: 'u12', merged: false });
});

test('a repo without a staging or develop branch is left unmarked', () => {
  const stg = raw(1, 'o/scraper', 'staging', 'a');
  assert.equal('developTwin' in (withDevelopTwins([stg], () => flow({ hasStaging: false }))[0] as object), false);
  assert.equal('developTwin' in (withDevelopTwins([stg], () => flow({ hasDevelop: false }))[0] as object), false);
});

test('PRs into other bases are never marked, and each repo is read once', () => {
  const calls: string[] = [];
  const prs = [raw(1, 'o/a', 'staging', 'x'), raw(2, 'o/a', 'staging', 'y'), raw(3, 'o/a', 'main', 'z'), raw(4, 'o/b', 'develop', 'w')];
  const out = withDevelopTwins(prs, (r) => { calls.push(r); return flow(); });
  assert.deepEqual(calls, ['o/a']);
  assert.deepEqual(out.map((p) => 'developTwin' in p), [true, true, false, false]);
});

test('a stored twin is absent, null or a full twin; anything else is damage', () => {
  assert.ok(isStoredTwin(undefined) && isStoredTwin(null) && isStoredTwin({ number: 1, url: 'u', merged: false }));
  assert.ok(!isStoredTwin({ number: '1', url: 'u', merged: false }) && !isStoredTwin('x') && !isStoredTwin({ number: 1 }));
});

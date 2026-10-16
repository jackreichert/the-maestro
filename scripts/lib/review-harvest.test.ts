// Run: node --test scripts/lib/review-harvest.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateStatus, coverageHints, fateFrom, gistOf, hintsFor, isCiCatchable, isPlanningMiss, itemsFrom, mergeItems, type Finding, type Item, type PrNode } from './review-harvest.ts';

const item = (over: Partial<Item>): Item => ({ srcId: 'c1', pr: 'rivendell/elrond-api#10', change: 'rivendell/elrond-api:feat/gate', kind: 'copilot', author: 'copilot-pull-request-reviewer', path: 'src/gate.mjs', text: 'The gate treats an empty allowlist as unrestricted, so a blank list grants every entity.', fate: 'open', outsideDiff: false, ...over });

test('gistOf drops fences, links and addresses, and withholds a PHI or secret shape', () => {
  const g = gistOf('Use a guard.\n```js\nconst x = 1;\n```\nSee https://example.com/x or mail frodo@shire.example now.');
  assert.equal(g, 'Use a guard. See or mail now.');
  assert.match(gistOf('The sample has SSN 123-45-6789 inline'), /withheld/);
  assert.ok(gistOf('word '.repeat(100)).length <= 240);
});

test('twin PRs and repeat Copilot passes collapse to one finding; the thread count and PR list stay', () => {
  const a = item({ srcId: 'c1' });
  const twin = item({ srcId: 'c2', pr: 'rivendell/elrond-api#11', text: 'The gate treats an empty allowlist as unrestricted, so a blank list grants every entity!' });
  const again = item({ srcId: 'c3', fate: 'fixed' });
  const out = mergeItems([], [a, twin, again], '2026-10-16');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.threads, 3);
  assert.deepEqual(out[0]!.prs, ['rivendell/elrond-api#10', 'rivendell/elrond-api#11']);
  assert.equal(out[0]!.fate, 'fixed');
});

test('a different file or different words is a different finding, and a re-read changes nothing', () => {
  const a = item({ srcId: 'c1' });
  const other = item({ srcId: 'c2', path: 'src/other.mjs', text: 'The retry loop never backs off, so a down service is hammered.' });
  const once = mergeItems([], [a, other], '2026-10-16');
  assert.equal(once.length, 2);
  assert.deepEqual(mergeItems(once, [a, other], '2026-10-17'), once);
});

test('the same words in another file merge only when nearly identical', () => {
  const a = item({ srcId: 'c1' });
  const sameWords = item({ srcId: 'c2', path: 'src/else.mjs' });
  const loose = item({ srcId: 'c3', path: 'src/else.mjs', text: 'The gate treats an empty allowlist as unrestricted.' });
  assert.equal(mergeItems([], [a, sameWords], 'd').length, 1);
  assert.equal(mergeItems([], [a, loose], 'd').length, 2);
});

test('a bot finding and a human finding are never merged, and withheld text never merges', () => {
  const bot = item({ srcId: 'c1' });
  const human = item({ srcId: 'c2', kind: 'human', author: 'samwise' });
  assert.equal(mergeItems([], [bot, human], 'd').length, 2);
  const w1 = item({ srcId: 'w1', text: gistOf('SSN 123-45-6789') });
  const w2 = item({ srcId: 'w2', text: gistOf('SSN 987-65-4321') });
  const two = mergeItems([], [w1, w2], 'd');
  assert.equal(two.length, 2);
  assert.notEqual(two[0]!.id, two[1]!.id);
});

test('planning-miss filter: prior art outside the diff, not in-diff drift or database duplicates', () => {
  assert.ok(isPlanningMiss('Core already has a helper for this, use it instead.'));
  assert.ok(isPlanningMiss('The sibling EMR scraper does this differently: it reads the id from the header.'));
  assert.ok(isPlanningMiss('This duplicates the existing retry helper in the shared client.'));
  assert.ok(!isPlanningMiss('A duplicate key error is raised when two rows share the id.'));
  assert.ok(!isPlanningMiss('This list is a hand-copied copy and omits the new entry.'));
});

test('real-miss filters: CI-catchable, pre-existing and outside-the-diff are hinted, ordinary findings are not', () => {
  assert.ok(isCiCatchable('ESLint would flag this unused import.'));
  assert.deepEqual(hintsFor({ text: 'This is pre-existing code, not part of this PR.', outsideDiff: false }), ['pre-existing']);
  assert.deepEqual(hintsFor({ text: 'Null check missing.', outsideDiff: true }), ['pre-existing']);
  assert.deepEqual(hintsFor({ text: 'Null check missing.', outsideDiff: false }), []);
});

test('fate is read from Jack replies, else from the thread state', () => {
  assert.equal(fateFrom(true, ['Good catch, fixed in abc123']), 'fixed');
  assert.equal(fateFrom(false, ['This is a false positive, reset on every call']), 'declined');
  assert.equal(fateFrom(false, ['Will do in a follow-up ticket']), 'deferred');
  assert.equal(fateFrom(true, []), 'resolved');
  assert.equal(fateFrom(false, []), 'open');
});

const pr = (over: Partial<PrNode> = {}): PrNode => ({
  headRefName: 'feat/gate', files: { nodes: [{ path: 'src/gate.mjs' }] },
  reviewThreads: { nodes: [
    { isResolved: true, path: 'src/gate.mjs', comments: { nodes: [{ id: 't1', body: 'Empty allowlist is read as unrestricted.', author: { login: 'copilot-pull-request-reviewer' } }, { id: 't1r', body: 'fixed', author: { login: 'jack' } }] } },
    { isResolved: false, path: 'src/old.mjs', comments: { nodes: [{ id: 't2', body: 'Missing null check here.', author: { login: 'samwise' } }] } },
    { isResolved: true, path: 'src/gate.mjs', comments: { nodes: [{ id: 't3', body: 'my own note on the diff', author: { login: 'jack' } }] } },
  ] },
  reviews: { nodes: [
    { id: 'r1', body: 'Pull request overview: this PR changes the gate and adds tests for it.', author: { login: 'copilot-pull-request-reviewer' } },
    { id: 'r2', body: 'The description says the allowlist is kept but the diff removes it.', author: { login: 'samwise' } },
    { id: 'r3', body: 'LGTM', author: { login: 'samwise' } },
  ] },
  comments: { nodes: [{ id: 'k1', body: 'High severity: lodash has a known vulnerability in this lockfile.', author: { login: 'aikido-pr-checks' } }] },
  ...over,
});

test('itemsFrom keeps humans and Aikido, skips Jack, Copilot overview bodies and one-word reviews, and flags paths outside the diff', () => {
  const got = itemsFrom(pr(), 'rivendell/elrond-api#10', 'jack');
  assert.deepEqual(got.map((i) => i.srcId), ['t1', 't2', 'r2', 'k1']);
  assert.equal(got[0]!.fate, 'fixed');
  assert.equal(got[1]!.outsideDiff, true);
  assert.equal(got[2]!.kind, 'human');
  assert.equal(got[3]!.kind, 'aikido');
  assert.equal(got[0]!.change, 'rivendell/elrond-api:feat/gate');
});

test('a truncated file list makes no outside-the-diff claim', () => {
  const got = itemsFrom(pr({ files: { pageInfo: { hasNextPage: true }, nodes: [{ path: 'src/gate.mjs' }] } }), 'rivendell/elrond-api#10', 'jack');
  assert.equal(got.find((i) => i.srcId === 't2')!.outsideDiff, false);
});

test('coverageHints names the skill line sharing the most words, and nothing for an unrelated finding', () => {
  const skills = { 'code-quality': ['4. Absent, empty and malformed input stay distinct; never read unparseable values as none.'], persistence: ['4. Bound results with LIMIT and name columns.'] };
  const got = coverageHints('A malformed value is read as empty input, so the sweep proceeds', skills);
  assert.equal(got[0]!.skill, 'code-quality');
  assert.deepEqual(coverageHints('Rename the button label', skills), []);
});

test('candidate status: twin copies are one change; two changes or two repos make it ready', () => {
  const f = (changes: string[], prs: string[]): Finding => ({ id: 'x', seen: 'd', kind: 'copilot', path: '', gist: '', prs, changes, threads: 1, srcIds: [], fate: 'open', hints: [] });
  assert.equal(candidateStatus([f(['r/a:feat'], ['r/a#1', 'r/a#2'])]), 'watching');
  assert.equal(candidateStatus([f(['r/a:feat'], ['r/a#1', 'r/a#2']), f(['r/a:feat'], ['r/a#1'])]), 'watching');
  assert.equal(candidateStatus([f(['r/a:feat'], ['r/a#1']), f(['r/a:fix'], ['r/a#3'])]), 'ready');
  assert.equal(candidateStatus([f(['r/a:feat'], ['r/a#1']), f(['s/b:feat'], ['s/b#1'])]), 'ready');
});

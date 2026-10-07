// Run: node --test scripts/lib/stack-cap.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStacks, stackLines } from './stack-cap.ts';
import type { StackPr } from './stack-cap.ts';

const NOW = new Date('2026-10-10T00:00:00Z');
const LIMITS = { maxDepth: 3, maxAgeDays: 5 };
const pr = (n: number, head: string, base: string, createdAt = '2026-10-09T00:00:00Z', repo = 'org/a'): StackPr =>
    ({ key: `${repo}#${n}`, repo, number: n, url: `https://github.com/${repo}/pull/${n}`, headRefName: head, baseRefName: base, createdAt });

test('a PR that nothing stacks on is not a stack', () => {
    assert.deepEqual(findStacks([pr(1, 'f1', 'develop'), pr(2, 'f2', 'develop')], NOW, LIMITS), []);
});

test('a chain of three is within the depth cap; a fourth PR goes over it', () => {
    const three = [pr(1, 'f1', 'develop'), pr(2, 'f2', 'f1'), pr(3, 'f3', 'f2')];
    const [s] = findStacks(three, NOW, LIMITS);
    assert.deepEqual([s.depth, s.overDepth, s.overAge], [3, false, false]);
    const [t] = findStacks([...three, pr(4, 'f4', 'f3')], NOW, LIMITS);
    assert.deepEqual([t.depth, t.overDepth], [4, true]);
    assert.deepEqual(t.chain.map((p) => p.number), [1, 2, 3, 4]);
});

test('age runs from the oldest PR in the stack', () => {
    const [s] = findStacks([pr(1, 'f1', 'develop', '2026-10-03T00:00:00Z'), pr(2, 'f2', 'f1')], NOW, LIMITS);
    assert.equal(s.ageDays, 7);
    assert.equal(s.overAge, true);
    assert.equal(s.overDepth, false);
});

test('an exactly 5 day old stack is within the cap', () => {
    const [s] = findStacks([pr(1, 'f1', 'develop', '2026-10-05T00:00:00Z'), pr(2, 'f2', 'f1')], NOW, LIMITS);
    assert.equal(s.overAge, false);
});

test('a snapshot without creation times still reports depth and never guesses age', () => {
    const noTime = (p: StackPr): StackPr => ({ ...p, createdAt: undefined });
    const [s] = findStacks([noTime(pr(1, 'f1', 'develop')), noTime(pr(2, 'f2', 'f1'))], NOW, LIMITS);
    assert.equal(s.ageDays, null);
    assert.equal(s.overAge, false);
});

test('same branch names in another repo do not join a stack', () => {
    assert.deepEqual(findStacks([pr(1, 'f1', 'develop'), pr(2, 'f2', 'f1', undefined, 'org/b')], NOW, LIMITS), []);
});

test('a branching stack counts its longest chain, and a base cycle terminates', () => {
    const [s] = findStacks([pr(1, 'f1', 'develop'), pr(2, 'f2', 'f1'), pr(3, 'f3', 'f1'), pr(4, 'f4', 'f3')], NOW, LIMITS);
    assert.deepEqual(s.chain.map((p) => p.number), [1, 3, 4]);
    assert.deepEqual(findStacks([pr(1, 'a', 'b'), pr(2, 'b', 'a')], NOW, LIMITS), []);
});

test('stackLines names the over-cap stack and the PR to merge first, or says none', () => {
    const lines = stackLines([pr(1, 'f1', 'develop', '2026-10-01T00:00:00Z'), pr(2, 'f2', 'f1'), pr(3, 'f3', 'f2'), pr(4, 'f4', 'f3')], NOW, LIMITS);
    assert.equal(lines[0], 'Stacks over the cap (3 deep, 5 days): 1');
    assert.match(lines[1], /org\/a: 4 deep, 9 days old: #1 <- #2 <- #3 <- #4\. Stop adding to the top; drive org\/a#1 to merge: https:\/\/github\.com\/org\/a\/pull\/1/);
    assert.deepEqual(stackLines([pr(1, 'f1', 'develop')], NOW, LIMITS), ['Stacks over the cap (3 deep, 5 days): none']);
});

// Run: node --test scripts/web/client/test/chart-math.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldToOther, linePath, linearScale, niceTicks, shares, stack } from '../src/chart-math.ts';

test('linearScale maps the domain ends to the range ends and inverts for y axes', () => {
  const x = linearScale([0, 10], [0, 100]);
  assert.equal(x(0), 0);
  assert.equal(x(5), 50);
  assert.equal(x(10), 100);
  const y = linearScale([0, 4], [200, 0]);
  assert.equal(y(0), 200);
  assert.equal(y(4), 0);
});

test('linearScale on a zero-width domain returns the range start instead of NaN', () => {
  assert.equal(linearScale([3, 3], [10, 90])(3), 10);
});

test('niceTicks start at 0, are evenly spaced round numbers, and cover the max', () => {
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(10), [0, 5, 10]);
  const t = niceTicks(23, 4);
  assert.equal(t[0], 0);
  assert.ok(t[t.length - 1] >= 23);
  assert.ok(t.length <= 7);
});

test('niceTicks with no data still gives an axis', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(0.8), [0, 0.2, 0.4, 0.6, 0.8]);
});

test('stack accumulates in key order, ignores unknown keys and clamps negatives', () => {
  assert.deepEqual(stack({ a: 2, b: 3, z: 9 }, ['a', 'b', 'c']), [
    { key: 'a', value: 2, start: 0, end: 2 },
    { key: 'b', value: 3, start: 2, end: 5 },
    { key: 'c', value: 0, start: 5, end: 5 },
  ]);
  assert.equal(stack({ a: -4 }, ['a'])[0].end, 0);
});

test('foldToOther keeps the largest and folds the tail into Other, never exceeding the limit', () => {
  const totals = { a: 5, b: 9, c: 1, d: 3, e: 3 };
  assert.deepEqual(foldToOther(totals, 3), ['b', 'a', 'Other']);
  assert.deepEqual(foldToOther({ a: 1, b: 2 }, 8), ['b', 'a']);
  assert.equal(foldToOther(totals, 8).length, 5);
});

test('shares sum to 1, and an all-zero input does not divide by zero', () => {
  const s = shares({ a: 1, b: 3 });
  assert.equal(s.a, 0.25);
  assert.equal(s.b, 0.75);
  assert.deepEqual(shares({ a: 0 }), { a: 0 });
});

test('linePath builds M then L commands and is empty for no points', () => {
  assert.equal(linePath([[0, 10], [5, 20]]), 'M0.0 10.0 L5.0 20.0');
  assert.equal(linePath([]), '');
});

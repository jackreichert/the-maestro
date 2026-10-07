// Run: node --test scripts/web/client/test/memo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoByKey } from '../src/memo.ts';

test('memoByKey builds each distinct key once and returns the same value every time after', () => {
  const built: string[] = [];
  const sheet = memoByKey((css) => { built.push(css); return { css }; });
  const a1 = sheet('a { color: red }');
  const a2 = sheet('a { color: red }');
  const b = sheet('b { color: blue }');
  assert.equal(a1, a2, 'the same object, not an equal copy');
  assert.notEqual(a1, b);
  assert.deepEqual(built, ['a { color: red }', 'b { color: blue }']);
});

test('memoByKey caches a falsy value instead of rebuilding it', () => {
  let calls = 0;
  const zero = memoByKey(() => { calls++; return 0; });
  assert.equal(zero('k'), 0);
  assert.equal(zero('k'), 0);
  assert.equal(calls, 1);
});

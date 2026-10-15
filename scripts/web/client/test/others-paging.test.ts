// Run: node --test scripts/web/client/test/others-paging.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, pagePlan } from '../src/others-paging.ts';

const rows = (n: number): { id: number; pin: boolean }[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, pin: false }));
const pin = (r: { pin: boolean }): boolean => r.pin;

test('the first page is 25 rows in their order, and more is offered with the count left', () => {
  const p = pagePlan(rows(60), pin, 0);
  assert.equal(PAGE_SIZE, 25);
  assert.deepEqual([p.shown.length, p.total, p.hidden, p.shown[0]?.id, p.shown[24]?.id], [25, 60, 35, 1, 25]);
});

test('each press shows 25 more, and the last page shows only what is left', () => {
  assert.deepEqual([pagePlan(rows(60), pin, 1).shown.length, pagePlan(rows(60), pin, 2).shown.length, pagePlan(rows(60), pin, 2).hidden], [50, 60, 0]);
  assert.equal(pagePlan(rows(60), pin, 9).shown.length, 60);
});

test('a list that fits one page has nothing hidden', () => {
  const p = pagePlan(rows(25), pin, 0);
  assert.deepEqual([p.shown.length, p.hidden], [25, 0]);
  assert.deepEqual(pagePlan([], pin, 0).shown, []);
});

test('pinned rows lead, in their order, and are never hidden behind the paging', () => {
  const list = rows(100).map((r) => ({ ...r, pin: r.id === 90 || r.id === 70 || r.id === 99 }));
  const p = pagePlan(list, pin, 0);
  assert.deepEqual(p.shown.slice(0, 3).map((r) => r.id), [70, 90, 99]);
  assert.equal(p.shown.length, 3 + 25, 'pinned rows do not use up the page');
  assert.equal(p.hidden, 100 - 28);
  assert.deepEqual(p.shown.slice(3, 6).map((r) => r.id), [1, 2, 3]);
  assert.ok(!p.shown.slice(3).some((r) => r.pin), 'a pinned row is listed once');
});

test('with more pinned rows than a page, all of them still show', () => {
  const list = rows(80).map((r) => ({ ...r, pin: r.id <= 40 }));
  const p = pagePlan(list, pin, 0);
  assert.deepEqual([p.shown.length, p.hidden], [40 + 25, 15]);
});

test('the first newly loaded row is the first one after the previous page', () => {
  const list = rows(60);
  const before = pagePlan(list, pin, 0);
  const after = pagePlan(list, pin, 1);
  assert.equal(after.shown[before.shown.length]?.id, 26);
});

// Run: node --test scripts/web/client/test/others-paging.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, pagePlan } from '../src/others-paging.ts';

const rows = (n: number): { id: number; pin: boolean }[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, pin: false }));
const pin = (r: { pin: boolean }): boolean => r.pin;

test('the first page is 25 rows in their order, with the page count', () => {
  const p = pagePlan(rows(60), pin, 1);
  assert.equal(PAGE_SIZE, 25);
  assert.deepEqual([p.shown.length, p.total, p.view.pages, p.shown[0]?.id, p.shown[24]?.id], [25, 60, 3, 1, 25]);
});

test('each page shows the next 25, the last shows what is left, and a page past the end clamps', () => {
  assert.deepEqual([2, 3].map((n) => pagePlan(rows(60), pin, n).shown.map((r) => r.id)).map((ids) => [ids.length, ids[0]]), [[25, 26], [10, 51]]);
  assert.deepEqual([pagePlan(rows(60), pin, 9).view.page, pagePlan(rows(60), pin, 0).view.page], [3, 1]);
});

test('a list that fits one page has one page', () => {
  const p = pagePlan(rows(25), pin, 1);
  assert.deepEqual([p.shown.length, p.view.pages], [25, 1]);
  assert.deepEqual(pagePlan([], pin, 1).shown, []);
});

test('pinned rows lead, in their order, on every page, and are never paged away', () => {
  const list = rows(100).map((r) => ({ ...r, pin: r.id === 90 || r.id === 70 || r.id === 99 }));
  const p = pagePlan(list, pin, 1);
  assert.deepEqual(p.shown.slice(0, 3).map((r) => r.id), [70, 90, 99]);
  assert.equal(p.shown.length, 3 + 25, 'pinned rows do not use up the page');
  assert.equal(p.view.pages, 4, '97 unpinned rows make four pages');
  assert.deepEqual(p.shown.slice(3, 6).map((r) => r.id), [1, 2, 3]);
  assert.ok(!p.shown.slice(3).some((r) => r.pin), 'a pinned row is listed once');
  assert.deepEqual(pagePlan(list, pin, 2).shown.slice(0, 4).map((r) => r.id), [70, 90, 99, 26]);
});

test('with more pinned rows than a page, all of them still show', () => {
  const list = rows(80).map((r) => ({ ...r, pin: r.id <= 40 }));
  const p = pagePlan(list, pin, 1);
  assert.deepEqual([p.shown.length, p.view.pages], [40 + 25, 2]);
});

// Run: node --test scripts/web/client/test/pager.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { pageView } from '../src/page-math.ts';

installDom();
const { PAGES, pagedRows } = await import('../src/pager.ts');
const { h } = await import('../src/dom.ts');

const rows = (n: number): HTMLElement[] => Array.from({ length: n }, (_, i) => h('div', { class: 'r' }, String(i + 1)));
const visible = (rs: HTMLElement[]): number[] => rs.flatMap((r, i) => (r.hidden ? [] : [i + 1]));
const status = (nav: HTMLElement | null): string => (nav?.querySelector('.pg-status')?.textContent ?? '');

test('pageView counts pages, clamps the page, and gives the 1-based range', () => {
  assert.deepEqual(pageView(14, 1, 6), { page: 1, pages: 3, size: 6, total: 14, from: 1, to: 6 });
  assert.deepEqual(pageView(14, 3, 6), { page: 3, pages: 3, size: 6, total: 14, from: 13, to: 14 });
  assert.equal(pageView(14, 99, 6).page, 3);
  assert.equal(pageView(14, -2, 6).page, 1);
  assert.deepEqual(pageView(0, 1, 6), { page: 1, pages: 1, size: 6, total: 0, from: 0, to: 0 });
  assert.equal(pageView(6, 1, 6).pages, 1, 'a full single page is one page');
});

test('a list that fits one page has no pager and shows every row', () => {
  PAGES.clear();
  const rs = rows(6);
  assert.equal(pagedRows(rs, { key: 'a', size: 6, label: 'Things' }), null);
  assert.deepEqual(visible(rs), [1, 2, 3, 4, 5, 6]);
});

test('the pager shows Page N of M, names the list, and Next and Previous swap pages without a redraw', () => {
  PAGES.clear();
  const rs = rows(14);
  const nav = pagedRows(rs, { key: 'b', size: 6, label: 'Things' })!;
  place(h('div', {}, ...rs, nav));
  assert.equal(nav.getAttribute('aria-label'), 'Things pages');
  assert.equal(status(nav), 'Page 1 of 3 (1–6 of 14)');
  assert.deepEqual(visible(rs), [1, 2, 3, 4, 5, 6]);
  const prev = nav.querySelector('[data-dir=prev]') as HTMLButtonElement;
  const next = nav.querySelector('[data-dir=next]') as HTMLButtonElement;
  assert.equal(prev.getAttribute('aria-disabled'), 'true');
  assert.equal(prev.getAttribute('aria-label'), 'Previous page of Things');
  next.focus();
  next.click();
  assert.deepEqual(visible(rs), [7, 8, 9, 10, 11, 12]);
  assert.equal(status(nav), 'Page 2 of 3 (7–12 of 14)');
  assert.equal(document.activeElement, next, 'focus stays on the pressed button');
  next.click();
  assert.deepEqual(visible(rs), [13, 14]);
  assert.equal(next.getAttribute('aria-disabled'), 'true');
  next.click();
  assert.deepEqual(visible(rs), [13, 14], 'Next on the last page does nothing');
  prev.click();
  assert.deepEqual(visible(rs), [7, 8, 9, 10, 11, 12]);
  assert.equal(prev.getAttribute('aria-disabled'), 'false');
});

test('the page is kept by key across a redraw, and clamped when the list shrinks', () => {
  PAGES.clear();
  const first = rows(14);
  (pagedRows(first, { key: 'c', size: 6, label: 'Things' })!.querySelector('[data-dir=next]') as HTMLButtonElement).click();
  const again = rows(14);
  const nav = pagedRows(again, { key: 'c', size: 6, label: 'Things' })!;
  assert.equal(status(nav), 'Page 2 of 3 (7–12 of 14)', 'a live refresh lands on the same page');
  const shrunk = rows(8);
  assert.equal(status(pagedRows(shrunk, { key: 'c', size: 6, label: 'Things' })!), 'Page 2 of 2 (7–8 of 8)');
  const gone = rows(4);
  assert.equal(pagedRows(gone, { key: 'c', size: 6, label: 'Things' }), null);
  assert.deepEqual(visible(gone), [1, 2, 3, 4], 'when it fits again, everything shows');
});

test('a row type that sets its own display is still hidden: the pager css carries a [hidden] rule', async () => {
  const { PAGER_CSS } = await import('../src/pager-css.ts');
  assert.match(PAGER_CSS, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('the status is one message, a noun can name the rows, and a note follows the page', () => {
  PAGES.clear();
  const rs = rows(14);
  const nav = pagedRows(rs, { key: 'd', size: 6, label: 'Things', noun: 'asks', note: (v) => (v.page === 1 ? '2 are urgent on other pages' : '') })!;
  assert.equal(status(nav), 'Page 1 of 3 (1\u20136 of 14 asks)');
  assert.equal(nav.querySelectorAll('.pg-status').length, 1);
  assert.equal(nav.querySelector('.pg-status')?.getAttribute('role'), 'status');
  assert.equal(nav.querySelector('.pg-note')?.textContent, '2 are urgent on other pages');
  (nav.querySelector('[data-dir=next]') as HTMLButtonElement).click();
  assert.equal(nav.querySelector('.pg-note')?.textContent, '');
});

// Run: node --test scripts/web/client/test/done-view.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';
import { home } from './home-fixture.ts';
import type { DoneSource, StreamHome } from '../src/types.ts';

installDom();
const { doneTop } = await import('../src/done-view.ts');
const { PAGES } = await import('../src/pager.ts');

const src = (over: Partial<DoneSource> = {}): DoneSource => ({
  kind: 'epic', name: 'FAKE-1', ref: { label: 'FAKE-1', url: 'obsidian://open?vault=Fictional&file=FAKE-1' }, items: [], prose: null, more: 0, progress: null, finished: false, ...over,
});
const draw = (sources: DoneSource[], fix: string | null = null): HTMLElement => {
  PAGES.clear();
  const el = doneTop({ ...home(), stream: 'acme-widgets', done: { sources, fix } } as unknown as StreamHome);
  place(el);
  return el;
};

test('a checklist shows done and open items in words, with the count and a bar', () => {
  const el = draw([src({ items: [{ text: 'Exporter live', checked: true }, { text: 'Docs updated', checked: false }, { text: 'Context', checked: null }], progress: { done: 1, total: 2, unit: 'checked' } })]);
  assert.match(el.textContent ?? '', /1 of 2 checked/);
  const items = [...el.querySelectorAll('li')].map((li) => li.textContent);
  assert.match(items[0] ?? '', /Done: Exporter live/);
  assert.match(items[1] ?? '', /Open: Docs updated/);
  assert.doesNotMatch(items[2] ?? '', /Done:|Open:/);
  assert.equal((el.querySelector('.dc-bar > span') as HTMLElement).style.width, '50%');
});

test('a met definition carries the Fine mark and says met to a screen reader; an unmet one has neither', () => {
  const met = draw([src({ progress: { done: 5, total: 5, unit: 'tickets' }, finished: true })]);
  assert.match(met.querySelector('.fine')?.textContent ?? '', /Fine/);
  assert.match(met.querySelector('.fine .vh')?.textContent ?? '', /met/);
  const open = draw([src({ progress: { done: 2, total: 5, unit: 'tickets' } })]);
  assert.equal(open.querySelector('.fine'), null);
  assert.match(open.textContent ?? '', /2 of 5 tickets closed/);
});

test('with nothing written it names the file to add it to and draws no card', () => {
  const el = draw([], 'Nothing written says what done looks like for acme-widgets. Add a "## What done looks like" section to Projects/acme/CONTEXT.md.');
  assert.equal(el.querySelectorAll('.done-card').length, 0);
  assert.match(el.querySelector('.done-empty')?.textContent ?? '', /Projects\/acme\/CONTEXT\.md/);
});

test('more than three definitions are paged, and the heading counts all of them', () => {
  const el = draw(Array.from({ length: 5 }, (_, i) => src({ name: `FAKE-${i + 1}` })));
  const cards = [...el.querySelectorAll('.done-card')] as HTMLElement[];
  assert.equal(cards.length, 5);
  assert.equal(cards.filter((c) => !c.hidden).length, 3);
  assert.match(el.querySelector('h2')?.textContent ?? '', /5/);
  assert.match(el.querySelector('.pg-status')?.textContent ?? '', /Page 1 of 2/);
});

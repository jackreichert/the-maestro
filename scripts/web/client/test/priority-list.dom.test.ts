// Run: node --test scripts/web/client/test/priority-list.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { PriorityData } from '../src/priority-list.ts';

installDom();
type List = HTMLElement & { data: PriorityData };
const data = (over: Partial<PriorityData> = {}): PriorityData => ({
  items: [{ text: 'Ship the thing [Avonlea]' }, { text: 'Review the other thing', stream: 'Tilling' }],
  max: 5, streams: ['Avonlea', 'Tilling'], editable: true, note: '', ...over,
});

test('the list is titled, counts against its cap, and shows each stream as a tag rather than bracketed text', async () => {
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data() });
  assert.equal(root.querySelector('h2')?.textContent, "Today's priorities");
  const rows = [...root.querySelectorAll('ol.priorities li')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.querySelector('.text')?.firstChild?.textContent, 'Ship the thing');
  assert.equal(rows[0]?.querySelector('a.tag')?.textContent, 'Avonlea');
  assert.equal(rows[1]?.querySelector('a.tag')?.textContent, 'Tilling');
  cleanup();
});

test('the add form stays folded until "+ Add a priority" is pressed, and is disabled at the cap', async () => {
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data() });
  assert.equal(root.querySelector('form.add'), null);
  const open = root.querySelector('#pl-open') as HTMLButtonElement;
  assert.equal(open.textContent, '+ Add a priority');
  open.click();
  assert.ok(root.querySelector('form.add'), 'pressing it opens the form');
  cleanup();
  const full = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data({ max: 2 }) });
  assert.equal((full.root.querySelector('#pl-open') as HTMLButtonElement).disabled, true);
  full.cleanup();
});

test('a page that may not edit offers no add control and no move or delete buttons', async () => {
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data({ editable: false }) });
  assert.equal(root.querySelector('#pl-open'), null);
  assert.equal(root.querySelectorAll('.tools').length, 0);
  cleanup();
});

test('the list is one keyboard-focusable, named region that holds the header, the cards and the add control', async () => {
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data() });
  const region = root.querySelector('[role="region"]') as HTMLElement;
  assert.equal(region.getAttribute('aria-label'), "Today's priorities");
  assert.equal(region.getAttribute('tabindex'), '0');
  assert.equal(root.querySelectorAll('[role="region"]').length, 1);
  for (const sel of ['.bar h2', 'ol.priorities', '#pl-open']) assert.ok(region.querySelector(sel), `${sel} is inside the scroll region`);
  assert.equal(region.querySelector('.fade')?.getAttribute('aria-hidden'), 'true', 'the fade is decoration');
  cleanup();
});

test('a redraw keeps the same region element, so its scroll position and focus survive it', async () => {
  const { el, root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data() });
  const before = root.querySelector('[role="region"]');
  el.data = data({ items: [{ text: 'Only one now' }] });
  assert.equal(root.querySelector('[role="region"]'), before);
  assert.equal(root.querySelectorAll('ol.priorities li').length, 1);
  cleanup();
});

test('a full-page redraw puts the region back where the reader had scrolled it, and focus finds its twin by id', async () => {
  const { keepRegionScroll } = await import('../src/priority-list.ts');
  const page = document.createElement('div');
  document.body.append(page);
  const make = (): List => { const el = document.createElement('priority-list') as List; el.data = data(); page.append(el); return el; };
  const old = make();
  const oldRegion = old.shadowRoot?.querySelector('.region') as HTMLElement;
  oldRegion.scrollTop = 120;
  const putBack = keepRegionScroll(page);
  old.remove();
  const fresh = make();
  const region = fresh.shadowRoot?.querySelector('.region') as HTMLElement;
  assert.equal(region.scrollTop, 0, 'a new region starts at the top');
  putBack();
  assert.equal(region.scrollTop, 120);
  assert.equal(region.id, 'pl-region', 'a stable id lets the page return focus to the region');
  fresh.remove();
  page.remove();
});

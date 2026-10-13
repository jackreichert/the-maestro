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

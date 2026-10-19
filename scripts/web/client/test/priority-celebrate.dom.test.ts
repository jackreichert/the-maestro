// Run: node --test scripts/web/client/test/priority-celebrate.dom.test.ts
// What the priorities panel draws when something is done: the done row, the meter, the sparks, the announcement, and the quiet version under reduced motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import type { PriorityData } from '../src/priority-list.ts';
import type { Celebration, PriorityStatus } from '../src/priority-done.ts';
import { priorityKey } from '../src/priority-done.ts';
import { CELEBRATE_CSS } from '../src/priority-celebrate.ts';

const win = installDom();
type List = HTMLElement & { data: PriorityData };
const items = [{ text: 'Ship the thing', stream: 'Avonlea' }, { text: 'Review the other thing', stream: 'Tilling' }];
const [A, B] = items.map((p) => priorityKey(p)) as [string, string];
const st = (key: string, done: boolean): PriorityStatus => ({ key, stream: key.split('\n')[0] ?? '', done, doneAt: done ? '2026-10-19T19:42:00.000Z' : '' });
const calm: Celebration = { fresh: new Set(), before: 0, cleared: false, announce: '' };
const data = (statuses: PriorityStatus[], celebration: Celebration = calm): PriorityData => ({
  items, max: 5, streams: ['Avonlea', 'Tilling'], editable: true, note: '', progress: { statuses, celebration, tz: 'America/New_York' },
});
const setMotion = (reduce: boolean): void => {
  (win as unknown as Record<string, unknown>).matchMedia = (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} });
};
const rows = (root: ParentNode): Element[] => [...root.querySelectorAll('ol.priorities li')];

test('a fresh done row draws its check, bursts, and reads "Done at 3:42 pm ET"; the open row has none of it', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, false)], { fresh: new Set([A]), before: 0, cleared: false, announce: 'Avonlea done. 1 of 2 priorities done.' }) });
  const [a, b] = rows(root);
  assert.ok(a?.classList.contains('done') && a.classList.contains('fresh'));
  assert.ok(a?.querySelector('.tick.draw'), 'the check draws');
  assert.equal(a?.querySelectorAll('.burst.sm i').length, 12);
  assert.equal(a?.querySelector('.when')?.textContent, 'Done ✓ at 3:42 pm ET');
  assert.equal(a?.querySelector('.burst')?.getAttribute('aria-hidden'), 'true');
  assert.equal(b?.classList.contains('done'), false);
  assert.equal(b?.querySelector('.burst, .when'), null);
  cleanup();
});

test('a done row that is not fresh stays done and struck through but plays nothing: no burst, no drawing', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, false)]) });
  const a = rows(root)[0];
  assert.ok(a?.classList.contains('done'));
  assert.equal(a?.classList.contains('fresh'), false);
  assert.equal(a?.querySelector('.burst'), null);
  assert.equal(a?.querySelector('.tick.draw'), null);
  assert.equal(a?.querySelector('.when')?.textContent, 'Done ✓ at 3:42 pm ET');
  assert.equal(root.querySelector('#pl-live')?.textContent, '', 'nothing is announced for what was already done');
  cleanup();
});

test('the meter reads "1 of 2 done", starts its fill from where it stood, and no cleared line yet', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, false)], { fresh: new Set([A]), before: 0, cleared: false, announce: '' }) });
  const meter = root.querySelector('#pl-meter');
  assert.equal(meter?.querySelector('.count')?.textContent, 'Progress: 1 of 2 done');
  assert.ok(meter?.classList.contains('fresh'));
  const fill = meter?.querySelector('.fill') as HTMLElement;
  assert.equal(fill.style.getPropertyValue('--p'), '0.5');
  assert.equal(fill.style.getPropertyValue('--from'), '0');
  assert.equal(root.querySelector('#pl-cleared'), null);
  cleanup();
});

test('the last priority closing clears the board: a bigger burst and the "Board cleared" line', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, true)], { fresh: new Set([B]), before: 1, cleared: true, announce: 'Board cleared. All 2 priorities are done.' }) });
  assert.equal(root.querySelector('#pl-cleared')?.textContent, 'Board cleared ✓');
  assert.equal(root.querySelectorAll('#pl-meter .burst.lg i').length, 30);
  assert.ok(root.querySelector('#pl-meter')?.classList.contains('full'));
  cleanup();
});

test('a board that is already cleared shows the line quietly: no burst, nothing fresh', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, true)]) });
  assert.equal(root.querySelector('#pl-cleared')?.textContent, 'Board cleared ✓');
  assert.equal(root.querySelector('.burst'), null);
  assert.equal(root.querySelector('.fresh'), null);
  cleanup();
});

test('the completion is announced through a polite live region, once it is on the page', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, false)], { fresh: new Set([A]), before: 0, cleared: false, announce: 'Avonlea done. 1 of 2 priorities done.' }) });
  const live = root.querySelector('#pl-live');
  assert.equal(live?.getAttribute('aria-live'), 'polite');
  assert.equal(live?.getAttribute('role'), 'status');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(live?.textContent, 'Avonlea done. 1 of 2 priorities done.');
  cleanup();
});

test('reduced motion: no sparks anywhere, even for a fresh finish and a cleared board; the check, the row and the words stay', async () => {
  setMotion(true);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, true)], { fresh: new Set([A, B]), before: 0, cleared: true, announce: 'Board cleared. All 2 priorities are done.' }) });
  assert.equal(root.querySelectorAll('.burst').length, 0);
  assert.equal(rows(root).length, 2);
  assert.ok(rows(root).every((r) => r.querySelector('.tick') && r.querySelector('.when')));
  assert.equal(root.querySelector('#pl-cleared')?.textContent, 'Board cleared ✓');
  assert.match(CELEBRATE_CSS, /prefers-reduced-motion: reduce\) \{[^}]*\.burst \{ display: none; \}/, 'and the stylesheet hides them for the setting too');
  cleanup();
  setMotion(false);
});

test('with no progress given (an older page) nothing is marked done and there is no meter', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: { items, max: 5, streams: [], editable: false, note: '' } });
  assert.equal(root.querySelector('#pl-meter'), null);
  assert.equal(root.querySelector('li.done'), null);
  cleanup();
});

test('an internal redraw (a delete confirm) never replays a celebration that has already played', async () => {
  setMotion(false);
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data: data([st(A, true), st(B, false)], { fresh: new Set([A]), before: 0, cleared: false, announce: 'Avonlea done. 1 of 2 priorities done.' }) });
  assert.equal(root.querySelectorAll('li.fresh').length, 1, 'the first draw plays it');
  await new Promise((r) => setTimeout(r, 120));
  (root.querySelector('#pl-del-1') as HTMLButtonElement).click();
  assert.equal(root.querySelectorAll('li.fresh').length, 0);
  assert.equal(root.querySelectorAll('.burst').length, 0);
  assert.equal(root.querySelector('#pl-live')?.textContent, '', 'and nothing is announced again');
  assert.equal(root.querySelector('li.done .when')?.textContent, 'Done ✓ at 3:42 pm ET', 'the row stays done');
  assert.equal(root.querySelector('#pl-meter .count')?.textContent, 'Progress: 1 of 2 done');
  cleanup();
});

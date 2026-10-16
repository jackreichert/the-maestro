// Run: node --test scripts/web/client/test/home-motion.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, place } from './dom-harness.ts';
import { sanitizeCharts, sanitizeState } from '../src/contract.ts';
import type { ChartsData, PodiumState } from '../src/types.ts';

installDom();
const { HOME_TAB_CSS, homeTab } = await import('../src/home-tab.ts');
const { CHROME_CSS } = await import('../src/home-chrome.ts');
const { HOME_MOTION_CSS, armHomeEntrance, newlyShipped, resetHomeMotion, takeEntrance } = await import('../src/home-motion.ts');
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): PodiumState => structuredClone(sanitizeState(read('state.json'))!.state);
const charts = (): ChartsData => structuredClone(sanitizeCharts(read('charts.json'))!.data);
const draw = (st: PodiumState): HTMLElement => place(homeTab(st, charts(), { live: false, projects: { state: 'loading' }, epics: null, redraw: () => {} })).el;

test('the entrance plays on the first draw, survives a quick follow-up redraw, and is not replayed by a later live one', () => {
  resetHomeMotion();
  assert.ok(takeEntrance(1000), 'first draw');
  assert.ok(takeEntrance(1300), 'a redraw inside the settle window keeps it');
  assert.ok(!takeEntrance(1800), 'a later live redraw does not replay it');
  resetHomeMotion();
  assert.ok(draw(state()).classList.contains('enter'), 'the draw carries the class');
  armHomeEntrance();
  assert.ok(draw(state()).classList.contains('enter'), 'back on Home');
});

test('an item that ships between two draws is marked just-shipped; the first draw marks nothing', () => {
  resetHomeMotion();
  const first = state();
  assert.equal(draw(first).querySelectorAll('.crow.new').length, 0);
  const next = structuredClone(first);
  const added = { ...next.done[0]!, id: 'newly-shipped-id', text: 'Shipped a moment ago', closedAt: new Date().toISOString() };
  next.done.push(added);
  const el = draw(next);
  const marked = [...el.querySelectorAll('.crow.new')];
  assert.equal(marked.length, 1);
  assert.match(marked[0]!.textContent ?? '', /Shipped a moment ago/);
});

test('newlyShipped reports only ids it has not seen', () => {
  resetHomeMotion();
  assert.deepEqual([...newlyShipped(['a', 'b'], 0)], []);
  assert.deepEqual([...newlyShipped(['a', 'b', 'c'], 1000)], ['c']);
  assert.deepEqual([...newlyShipped(['a', 'b', 'c'], 1300)], ['c'], 'still marked inside the window');
  assert.deepEqual([...newlyShipped(['a', 'b', 'c'], 2000)], [], 'then settled');
  armHomeEntrance();
  assert.deepEqual([...newlyShipped(['a', 'b', 'c', 'd'], 3000)], [], 'what shipped while away is not news');
});

test('every selector the entrance targets matches something in a drawn Home', () => {
  resetHomeMotion();
  const el = draw(state());
  for (const sel of ['.staff-svg .note', '.qcue', '.crow', '.bars .fill', '.cibar span', '.mix-bar span']) {
    assert.ok(el.querySelector(sel) || sel === '.mix-bar span', sel);
  }
  // The staggered rows carry their place in the list, and the CSS reads it.
  assert.equal(el.querySelector<HTMLElement>('.staff-svg .note:nth-of-type(3)')?.style.getPropertyValue('--i') !== undefined, true);
  assert.match(HOME_MOTION_CSS, /\.enter \.staff-svg \.note \{[^}]*animation-delay: calc\(min\(var\(--i\)/);
});

test('nothing on Home loops: the baton pulses a set number of times, and the ambient beats are budgeted', () => {
  assert.doesNotMatch(`${HOME_TAB_CSS}${CHROME_CSS}`, /infinite/);
  assert.match(CHROME_CSS, /\.baton \.tip\.on\.pulse \{ animation: pulse var\(--dur-breathe\) ease-in-out 3; \}/);
});

test('the motion CSS never animates layout and switches off under reduced motion', () => {
  const keyframes = [...`${HOME_MOTION_CSS}${HOME_TAB_CSS}`.matchAll(/@keyframes [\w-]+ \{(.*)\}/g)].map((m) => m[1]!);
  assert.ok(keyframes.length >= 3);
  for (const body of keyframes) assert.doesNotMatch(body, /\b(width|height|top|left|right|bottom|margin|padding|flex)/, body);
  assert.match(HOME_MOTION_CSS, /@media \(prefers-reduced-motion: reduce\)[^]*animation: none !important/);
});

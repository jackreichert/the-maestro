// Run: node --test scripts/web/client/test/stream-picker.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, place } from './dom-harness.ts';

installDom();
// Reduced motion: the menu opens and closes without animation, which happy-dom does not implement.
(globalThis as Record<string, unknown>).matchMedia = (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} });
const { streamPicker } = await import('../src/home-chrome.ts');

const voices = [
  { stream: null, name: 'All streams', n: 3 },
  { stream: 'acme-widgets', name: 'acme-widgets', n: 2 },
  { stream: 'ops', name: 'ops', n: 1 },
  { stream: 'other', name: 'other', n: 0 },
];

function build(current: string | null = null): { picks: Array<string | null>; btn: HTMLButtonElement; list: HTMLElement; menu: HTMLElement } {
  const picks: Array<string | null> = [];
  const root = streamPicker({ voices, current, pick: (s) => picks.push(s) });
  place(root);
  return { picks, btn: root.querySelector('#stream-btn') as HTMLButtonElement, list: root.querySelector('#stream-list') as HTMLElement, menu: root.querySelector('#stream-menu') as HTMLElement };
}
const key = (el: HTMLElement, k: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
const activeName = (list: HTMLElement): string => (list.querySelector('.sp-opt.active .sp-name')?.textContent ?? '').replace('tutti', '');

test('the button names the voice and its cue count, and the menu starts closed', () => {
  const { btn, menu } = build('acme-widgets');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.hidden, true);
  assert.equal(btn.querySelector('.sp-val')?.textContent, 'acme-widgets');
  assert.equal(btn.querySelector('.sp-count')?.textContent, '2 cues waiting');
  assert.match(btn.getAttribute('aria-labelledby') ?? '', /stream-n$/, 'the count is part of the accessible name');
});

test('opening puts the current voice active and the arrow keys, Home and End move with wrap', () => {
  const { btn, list, menu } = build('ops');
  btn.click();
  assert.equal(menu.hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(activeName(list), 'ops');
  assert.equal(list.getAttribute('aria-activedescendant'), 'sp-opt-ops');
  key(list, 'ArrowDown');
  assert.equal(activeName(list), 'other');
  key(list, 'ArrowDown');
  assert.equal(activeName(list), 'All streams', 'wraps past the end');
  key(list, 'End');
  assert.equal(activeName(list), 'other');
  key(list, 'Home');
  assert.equal(activeName(list), 'All streams');
  key(list, 'ArrowUp');
  assert.equal(activeName(list), 'other', 'wraps past the start');
});

test('type-ahead jumps to the next voice that starts with the letter', () => {
  const { btn, list } = build(null);
  btn.click();
  key(list, 'o');
  assert.equal(activeName(list), 'ops');
  key(list, 'o');
  assert.equal(activeName(list), 'other');
});

test('Enter picks the active voice and closes; the voice already shown is not a pick', () => {
  const { btn, list, menu, picks } = build('acme-widgets');
  btn.click();
  key(list, 'ArrowDown');
  key(list, 'Enter');
  assert.deepEqual(picks, ['ops']);
  assert.equal(menu.hidden, true);
  btn.click();
  key(list, 'Enter');
  assert.deepEqual(picks, ['ops']);
});

test('clicking an option picks it; a zero-cue voice reads tacet to the eye and "no cues" to a screen reader', () => {
  const { btn, list, picks } = build(null);
  btn.click();
  const other = list.querySelector('#sp-opt-other') as HTMLElement;
  assert.match(other.textContent ?? '', /tacet/);
  assert.match(other.querySelector('.vh')?.textContent ?? '', /no cues/);
  other.click();
  assert.deepEqual(picks, ['other']);
});

test('Escape closes and returns focus to the button; the current option is marked selected', () => {
  const { btn, list, menu } = build('ops');
  btn.click();
  assert.equal(list.querySelector('[aria-selected=true] .sp-name')?.textContent, 'ops');
  key(list, 'Escape');
  assert.equal(menu.hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, btn);
});

test('a press outside closes the open menu', () => {
  const { btn, menu } = build(null);
  btn.click();
  assert.equal(menu.hidden, false);
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
  assert.equal(menu.hidden, true);
});

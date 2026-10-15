// Run: node --test scripts/web/client/test/walkers.dom.test.ts
// The element: decorative and out of the way, a named toggle that remembers its state, nothing mounted while idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-harness.ts';

const win = installDom();
const store = new Map<string, string>();
Object.defineProperty(win, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
const { PodiumWalkers } = await import('../src/walkers.ts');
const { buildWalker } = await import('../src/walkers-art.ts');
const { WALKERS, STORAGE_KEY } = await import('../src/walkers-model.ts');
const { WALKERS_CSS } = await import('../src/walkers-css.ts');

function mountEl(): InstanceType<typeof PodiumWalkers> {
  const el = document.createElement('podium-walkers') as InstanceType<typeof PodiumWalkers>;
  document.body.append(el);
  return el;
}

test('the stage is aria-hidden, holds nothing while idle, and the toggle has an accessible name and state', () => {
  const el = mountEl();
  const root = el.shadowRoot!;
  assert.equal(root.querySelector('.stage')?.getAttribute('aria-hidden'), 'true');
  assert.equal(root.querySelector('.stage')?.children.length, 0);
  const toggle = root.querySelector('button')!;
  assert.match(toggle.getAttribute('aria-label') ?? '', /music/i);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  el.remove();
});

test('the toggle flips aria-pressed and persists the choice', () => {
  const el = mountEl();
  const toggle = el.shadowRoot!.querySelector('button')!;
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(store.get(STORAGE_KEY), '0');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(store.get(STORAGE_KEY), '1');
  el.remove();
});

test('a stored off switch is honoured at load', () => {
  store.set(STORAGE_KEY, '0');
  const el = mountEl();
  assert.equal(el.shadowRoot!.querySelector('button')!.getAttribute('aria-pressed'), 'false');
  el.remove();
  store.clear();
});

test('every walker draws, is aria-hidden line art, and uses no style attribute (the CSP forbids them)', () => {
  for (const w of WALKERS) {
    const { svg, width } = buildWalker(w.id);
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.ok(width > 20 && width < 200);
    assert.equal(svg.querySelectorAll('[style]').length, 0, w.id);
    assert.ok(svg.querySelectorAll('path, ellipse, circle, rect').length > 3, w.id);
  }
});

test('the layer never takes pointer events or space, sits behind the page, and reduced motion removes it', () => {
  assert.match(WALKERS_CSS, /\.stage \{[^}]*position: fixed[^}]*z-index: -1[^}]*pointer-events: none/);
  assert.match(WALKERS_CSS, /prefers-reduced-motion: reduce\) \{ \.stage, \.toggle \{ display: none; \}/);
  assert.doesNotMatch(WALKERS_CSS, /requestAnimationFrame/);
});

// Run: node --test scripts/web/client/test/keep-view.dom.test.ts
// keepAcross and the stream board's use of it, against real elements: a redraw must give back the open disclosure and the focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, mount } from './dom-harness.ts';
import { home } from './home-fixture.ts';
import { sanitizeState } from '../src/contract.ts';
import type { StreamHome } from '../src/types.ts';

installDom();
const { keepAcross } = await import('../src/keep-view.ts');
const fixtureState = sanitizeState(JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8')))!.state;

// A shadow root, as in the real page: only a root reports which of its controls has focus.
const page = (): ShadowRoot => {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<details data-fold="more"><summary id="more-toggle">More</summary><p>body</p></details>';
  document.body.append(host);
  return root;
};
const hostOf = (root: ShadowRoot): Element => root.host;

test('keepAcross puts an open disclosure and the focused control back after a redraw replaces them', () => {
  const host = page();
  const details = host.querySelector('details')!;
  details.open = true;
  (host.querySelector('summary') as HTMLElement).focus();
  keepAcross(host, () => { host.innerHTML = '<details data-fold="more"><summary id="more-toggle">More</summary><p>new body</p></details>'; });
  assert.equal(host.querySelector('details')!.open, true, 'the reader left it open');
  assert.equal(host.activeElement?.id, 'more-toggle', 'focus is back on the new summary');
  hostOf(host).remove();
});

test('without keepAcross the same redraw loses both (the failure the wrapper exists to prevent)', () => {
  const host = page();
  host.querySelector('details')!.open = true;
  (host.querySelector('summary') as HTMLElement).focus();
  host.innerHTML = '<details data-fold="more"><summary id="more-toggle">More</summary><p>new body</p></details>';
  assert.equal(host.querySelector('details')!.open, false);
  assert.notEqual(host.activeElement?.id, 'more-toggle');
  hostOf(host).remove();
});

test('a stream board keeps its open disclosure and focus when a changed home arrives', async () => {
  const stream = fixtureState.streams[0];
  const first = { ...home(), stream } as unknown as StreamHome;
  const { el, root, cleanup } = await mount<HTMLElement & { home: StreamHome | null }>('../src/stream-board.ts', 'stream-board', { stream, state: fixtureState, home: first });
  const fold = root.querySelector('details[data-fold]') as HTMLDetailsElement | null;
  assert.ok(fold, 'the fixture home has at least one named disclosure');
  fold.open = true;
  (fold.querySelector('summary') as HTMLElement).focus();
  const name = fold.getAttribute('data-fold');
  const changed = { ...first, unknowns: [...first.unknowns, { kind: 'x', text: 'A second unknown, so the home differs.' }], epics: first.epics } as StreamHome;
  el.home = changed;
  const after = root.querySelector(`details[data-fold="${name}"]`) as HTMLDetailsElement;
  assert.notEqual(after, fold, 'the home really was redrawn');
  assert.equal(after.open, true);
  assert.equal((root as ShadowRoot).activeElement?.tagName, 'SUMMARY');
  cleanup();
});

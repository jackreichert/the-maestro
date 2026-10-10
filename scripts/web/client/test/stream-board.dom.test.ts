// Run: node --test scripts/web/client/test/stream-board.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, mount } from './dom-harness.ts';
import { home } from './home-fixture.ts';
import { sanitizeState } from '../src/contract.ts';
import type { StreamHome } from '../src/types.ts';

installDom();
const st = sanitizeState(JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8')))!.state;
type Board = HTMLElement & { home: StreamHome | null; state: unknown };

test('an unchanged home leaves the board untouched, so an open disclosure is the same element', async () => {
  const stream = st.streams[0];
  const h1 = { ...home(), stream } as unknown as StreamHome;
  const { el, root, cleanup } = await mount<Board>('../src/stream-board.ts', 'stream-board', { stream, state: st, home: h1 });
  const fold = root.querySelector('details[data-fold]') as HTMLDetailsElement;
  assert.ok(fold);
  fold.open = true;
  el.home = structuredClone(h1);
  assert.equal(root.querySelector(`details[data-fold="${fold.getAttribute('data-fold')}"]`), fold, 'same node');
  assert.equal(fold.open, true);
  cleanup();
});

test('the board draws the stream heading and its home sections', async () => {
  const stream = st.streams[0];
  const { root, cleanup } = await mount<Board>('../src/stream-board.ts', 'stream-board', { stream, state: st, home: { ...home(), stream } as unknown as StreamHome });
  assert.ok(root.querySelectorAll('section').length >= 2);
  assert.match(root.textContent ?? '', /Where it stands/);
  cleanup();
});

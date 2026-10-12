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

test('an epic on the home base names the PRs that carry its ticket ids, and says how many more', async () => {
  const stream = st.streams[0];
  const h1 = { ...home(), stream } as unknown as StreamHome;
  (h1.epics[0] as unknown as Record<string, unknown>).prs = [{ label: 'avonlea-api#412', url: 'https://github.test/acme/avonlea-api/pull/412' }];
  (h1.epics[0] as unknown as Record<string, unknown>).prsMore = 2;
  const { root, cleanup } = await mount<Board>('../src/stream-board.ts', 'stream-board', { stream, state: st, home: h1 });
  const meta = [...root.querySelectorAll('.epic-meta')].map((m) => m.textContent ?? '').find((t) => /avonlea-api#412/.test(t));
  assert.ok(meta, 'the PR shows in the epic block');
  assert.match(meta!, /PRs: avonlea-api#412 and 2 more/);
  cleanup();
});

test('an epic block shows a stale-brief badge outside its fold, keeps the brief and documents inside it, and a closed epic shows no badge', async () => {
  const stream = st.streams[0];
  const h1 = { ...home(), stream } as unknown as StreamHome;
  const [open, closed] = h1.epics as unknown as Record<string, unknown>[];
  open!.brief = { state: 'stale', updated: '2026-01-01', staleBecause: ['3 tickets changed'], blocks: [{ type: 'paragraph', runs: [{ text: 'Status text.' }] }] };
  open!.docs = { groups: [{ kind: 'plan', items: [{ title: 'Rollout plan', kind: 'plan', project: 'p', ticket: 't', url: 'obsidian://open?vault=Fictional&file=plan' }], more: 0 }], unattributedRecent: 0 };
  closed!.status = 'closed';
  closed!.brief = { state: 'missing' };
  const { root, cleanup } = await mount<Board>('../src/stream-board.ts', 'stream-board', { stream, state: st, home: h1 });
  const badges = [...root.querySelectorAll('.brief-badge')];
  assert.equal(badges.length, 1, 'the closed epic has none');
  assert.ok(badges[0]!.closest('details') === null, 'the badge is not hidden inside the closed fold');
  const fold = root.querySelector('details[data-fold="epic-docs-avonlea-api-042"]');
  assert.ok(fold);
  assert.match(fold!.querySelector('summary')?.textContent ?? '', /Brief and documents/);
  assert.match(fold!.textContent ?? '', /Status text\./);
  assert.match(fold!.textContent ?? '', /Rollout plan/);
  cleanup();
});

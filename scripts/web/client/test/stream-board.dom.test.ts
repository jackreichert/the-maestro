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

test('a stale in-flight row gets its own Stale section, apart from In flight, and no section when there are none (MAESTRO-319)', async () => {
  const stream = st.streams[0];
  const h1 = { ...home(), stream } as unknown as StreamHome;
  const row = { id: 'zz01', stream, text: 'forgotten export', since: '2026-09-30T12:00:00Z', links: { tracker: [], prs: [] } };
  const titles = (root: ParentNode): string[] => [...root.querySelectorAll('section')].map((s) => (s.querySelector('h2, h3')?.textContent ?? '').split(',')[0].replace(/\d+$/, '').trim());
  const withStale = await mount<Board>('../src/stream-board.ts', 'stream-board', { state: { ...st, stale: [row] }, home: h1 });
  withStale.el.setAttribute('stream', stream);
  assert.ok(titles(withStale.root).includes('Stale'), titles(withStale.root).join('|'));
  assert.match(withStale.root.textContent ?? '', /forgotten export/);
  withStale.cleanup();
  const none = await mount<Board>('../src/stream-board.ts', 'stream-board', { state: st, home: h1 });
  none.el.setAttribute('stream', stream);
  assert.ok(!titles(none.root).includes('Stale'));
  none.cleanup();
});

test('the tab lists the documents shared for the project: links only through the policy, who and when in words, and the count includes what the server left out', async () => {
  const stream = st.streams[0];
  const h1 = { ...home(), stream } as unknown as StreamHome;
  h1.shared = [
    { title: 'UAT checklist', kind: 'web', url: 'https://example.com/uat', by: 'user', project: 'p', date: '2026-10-05', why: 'what QA signs off against' },
    { title: 'Local runbook', kind: 'file', path: 'repo/docs/run.md', by: 'user', project: 'p', date: '2026-10-03' },
    { title: 'Tampered', kind: 'web', url: 'javascript:alert(1)', by: 'user', project: 'p', date: '2026-10-02' },
  ];
  h1.sharedMore = 2;
  const { root, cleanup } = await mount<Board>('../src/stream-board.ts', 'stream-board', { stream, state: st, home: h1 });
  const fold = root.querySelector('details[data-fold="rail-shared"]');
  assert.ok(fold, 'a shared-docs fold');
  assert.match(fold!.querySelector('summary')!.textContent ?? '', /Shared docs \(5\)/);
  const rows = [...fold!.querySelectorAll('li')];
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.querySelector('a')?.getAttribute('href'), 'https://example.com/uat');
  assert.match(rows[0]!.textContent ?? '', /UAT checklist\s*web\s*shared by user on 2026-10-05 · what QA signs off against/);
  assert.equal(rows[1]!.querySelector('a'), null, 'a file with no link is plain text');
  assert.match(rows[1]!.textContent ?? '', /file\s*shared by user on 2026-10-03 · repo\/docs\/run\.md/);
  assert.equal(rows[2]!.querySelector('a'), null, 'an unsafe url never becomes an href');
  assert.match(fold!.textContent ?? '', /2 more not listed/);
  cleanup();
});

test('a tab with no shared documents draws no shared-docs fold', async () => {
  const stream = st.streams[0];
  const { root, cleanup } = await mount<Board>('../src/stream-board.ts', 'stream-board', { stream, state: st, home: { ...home(), stream } as unknown as StreamHome });
  assert.equal(root.querySelector('details[data-fold="rail-shared"]'), null);
  cleanup();
});

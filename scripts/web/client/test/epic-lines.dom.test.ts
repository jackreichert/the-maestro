// Run: node --test scripts/web/client/test/epic-lines.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount } from './dom-harness.ts';
import { epicLine, epics } from './home-fixture.ts';
import type { EpicLine } from '../src/types.ts';
import type { PriorityData } from '../src/priority-list.ts';

installDom();
type Lines = HTMLElement & { epics: EpicLine[] };
type List = HTMLElement & { data: PriorityData };
const e = epics();
const lines = (stream: string): EpicLine[] => e.streams.find((g: { stream: string }) => g.stream === stream).epics;

test('an epic line shows its progress with the denominator, the next ticket and the PRs that name it', async () => {
  const { root, cleanup } = await mount<Lines>('../src/epic-lines.ts', 'epic-lines', { epics: lines('Avonlea') });
  const text = root.textContent ?? '';
  assert.match(text, /9 of 14 closed \(64%\)/);
  assert.match(text, /2 in progress · 1 blocked · 2 not started/);
  assert.match(text, /Next: avonlea-api-051/);
  assert.equal([...root.querySelectorAll('a')].map((a) => a.textContent).includes('avonlea-api#412'), true);
  cleanup();
});

test('a link with a bad scheme is text, not an anchor', async () => {
  const bad = [epicLine('a-1', { note: { label: 'a-1', url: 'javascript:alert(1)' } }) as unknown as EpicLine];
  const { root, cleanup } = await mount<Lines>('../src/epic-lines.ts', 'epic-lines', { epics: bad });
  assert.equal(root.querySelectorAll('a').length, 0);
  cleanup();
});

test('priorities draw a stream\'s epics under its first priority only, and none for a stream without any', async () => {
  const data: PriorityData = {
    items: [{ text: 'Ship the pipeline', stream: 'Avonlea' }, { text: 'Second Avonlea thing', stream: 'Avonlea' }, { text: 'Pilot', stream: 'Green Gables' }, { text: 'No stream' }],
    max: 5, streams: ['Avonlea', 'Green Gables'], editable: false, note: '', epics: { Avonlea: lines('Avonlea'), 'Green Gables': lines('Green Gables') },
  };
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data });
  const rows = [...root.querySelectorAll('ol.priorities > li')];
  assert.deepEqual(rows.map((r) => r.querySelectorAll('epic-lines').length), [1, 0, 0, 0]);
  cleanup();
});

test('an editable list keeps its epics under the priority through a reorder render', async () => {
  const data: PriorityData = { items: [{ text: 'Ship the pipeline', stream: 'Avonlea' }], max: 5, streams: ['Avonlea'], editable: true, note: '', epics: { Avonlea: lines('Avonlea') } };
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data });
  assert.equal(root.querySelectorAll('ol.priorities > li epic-lines').length, 1);
  cleanup();
});

test('a long next-ticket link is clamped to two lines, with the whole text as the paragraph title and still in the page', async () => {
  const title = 'Make the exporter retry with exponential backoff when the upstream sample service answers 503 during the nightly window';
  const long = [epicLine('a-1', { next: { id: 'a-1-051', title, ref: { label: 'n', url: 'https://example.test/n' } } }) as unknown as EpicLine];
  const { root, cleanup } = await mount<Lines>('../src/epic-lines.ts', 'epic-lines', { epics: long });
  const next = root.querySelector('p.clamp') as HTMLElement;
  assert.equal(next.getAttribute('title'), `Next: a-1-051 ${title}`);
  assert.equal(next.querySelector('a')?.textContent, title, 'the link keeps its full text; only the paint is clamped');
  assert.equal(root.querySelectorAll('p.clamp').length, 1, 'PRs and progress lines are not clamped');
  const css = [...(root as ShadowRoot).adoptedStyleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join('\n');
  assert.match(css, /\.clamp\b[^}]*line-clamp:\s*2/);
  cleanup();
});

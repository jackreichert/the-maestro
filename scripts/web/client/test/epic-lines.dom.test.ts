// Run: node --test scripts/web/client/test/epic-lines.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, mount, place } from './dom-harness.ts';
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

test('the compact priority list draws no epics: they live on the stream tab', async () => {
  const data: PriorityData = {
    items: [{ text: 'Ship the pipeline', stream: 'Avonlea' }, { text: 'Pilot', stream: 'Green Gables' }],
    max: 5, streams: ['Avonlea', 'Green Gables'], editable: true, note: '',
  };
  const { root, cleanup } = await mount<List>('../src/priority-list.ts', 'priority-list', { data });
  assert.equal(root.querySelectorAll('epic-lines').length, 0);
  cleanup();
});

test('a stream tab draws that stream\'s epics, with what is next, under its priority; a stream with none draws no block', async () => {
  const { todayPanel } = await import('../src/home-sections.ts');
  const withEpics = place(todayPanel([{ text: 'Ship the pipeline', stream: 'Avonlea' }], null, 'Avonlea', lines('Avonlea'))).el;
  const block = withEpics.querySelector('epic-lines');
  assert.ok(block, 'the epic block is drawn');
  assert.equal(block.shadowRoot?.querySelectorAll('li').length, lines('Avonlea').length);
  assert.match(withEpics.textContent ?? '', /Ship the pipeline/);
  const none = place(todayPanel([], null, 'Avonlea')).el;
  assert.equal(none.querySelector('epic-lines'), null);
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

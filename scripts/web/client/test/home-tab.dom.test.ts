// Run: node --test scripts/web/client/test/home-tab.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, place } from './dom-harness.ts';
import { sanitizeCharts, sanitizeProjects, sanitizeState } from '../src/contract.ts';
import type { ChartsData, PodiumState, ProjectsData } from '../src/types.ts';
import type { ProjectsLoad } from '../src/home-tab.ts';

installDom();
const { homeTab } = await import('../src/home-tab.ts');
const homeSections = await import('../src/home-sections.ts');
const { homeUi } = homeSections;
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): PodiumState => structuredClone(sanitizeState(read('state.json'))!.state);
const charts = (): ChartsData => structuredClone(sanitizeCharts(read('charts.json'))!.data);
const projects = (): ProjectsData => structuredClone(sanitizeProjects(read('projects.json'))!.data);
let redraws = 0;
const draw = (st: PodiumState, c: ChartsData | null, p: ProjectsLoad): HTMLElement => {
  homeUi.order = 'oldest'; homeUi.stream = null; homeUi.allAsks = false; homeUi.allShipped = false;
  return place(homeTab(st, c, { live: false, projects: p, epics: null, redraw: () => { redraws += 1; } })).el;
};
const sec = (el: HTMLElement, name: string): Element => [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent?.startsWith(name))!;
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

test('Home is ordered by what needs acting on: cues, open work, open PRs, blocked, then the views that only report; every section is named by its heading', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const names = [...el.querySelectorAll('section > .sec-head h2')].map((x) => text(x).replace(/[\s,\d]+$/, ''));
  const at = (n: string): number => names.indexOf(n);
  const expected = ['Cues', 'In flight', 'Fermata: blocked', 'Open asks by age', 'Open PRs', 'Waiting for local review', 'The score', 'Epics', 'Coda: shipped today', 'The deck: shipped and asked per day'];
  assert.deepEqual(expected.map((n) => at(n) > -1), expected.map(() => true), names.join('|'));
  assert.ok(at('Cues') < at('In flight') && at('Fermata: blocked') < at('Open asks by age') && at('Open PRs') < at('The score') && at('The score') < at('Epics') && at('Epics') < at('The deck: shipped and asked per day'), names.join('|'));
  for (const s of el.querySelectorAll('section[aria-labelledby]')) assert.ok(el.querySelector(`#${s.getAttribute('aria-labelledby')}`), 'each region is named by its heading');
  // The instrument name above each heading is decoration: the heading is what names the region.
  assert.deepEqual([...el.querySelectorAll('.sec-title .instrument')].every((i) => i.getAttribute('aria-hidden') === 'true'), true);
});

test('Home is one grid whose children are placed as thirds or two thirds', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const home = el;
  assert.ok(home.classList.contains('grid'));
  assert.ok(home.querySelector(':scope > section.two-thirds'), 'the cues take two thirds');
  assert.ok(home.querySelectorAll(':scope > .third').length >= 3, 'the side column and the gauges sit in thirds');
});

test('the score has a row per stream with a state word, and a missing charts payload says so instead of a blank', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  assert.ok(el.querySelectorAll('.staff-row').length >= 2, 'one staff per stream');
  assert.ok(el.querySelector('.staff-row svg.staff-svg line.sl'), 'each staff has its five lines');
  assert.match(text(el), /waiting on you/);
  assert.match(text(el.querySelector('table.vh caption')), /Tasks finished per stream per day/);
  const none = draw(state(), null, { state: 'ok', data: projects() });
  assert.match(text(none.querySelector('[role=status]')), /14-day score is missing/);
  assert.ok(sec(none, 'Cues').querySelector('ask-card'), 'asks do not wait on the charts');
});

test('a failed projects load is an alert in place and the board is still drawn', () => {
  const el = draw(state(), charts(), { state: 'error', message: 'HTTP 500' });
  assert.match(text(el.querySelector('[role=alert]')), /Project names and notes could not be loaded \(HTTP 500\)/);
  assert.ok(sec(el, 'Cues').querySelector('ask-card'));
});

test('while projects load nothing is announced as an error and the asks are drawn', () => {
  const el = draw(state(), charts(), { state: 'loading' });
  assert.equal(el.querySelector('[role=alert]'), null);
  assert.ok(sec(el, 'Cues').querySelector('ask-card'));
});

test('the order control is a labelled select that asks the caller to redraw', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const order = el.querySelector<HTMLSelectElement>('select[data-ctl=order]')!;
  assert.equal(el.querySelector(`label[for=${order.id}]`)?.textContent?.startsWith('Order'), true, 'the select has a visible label');
  assert.deepEqual([...order.options].map((o) => o.value), ['oldest', 'oneway', 'stream']);
  assert.equal(order.value, 'oldest');
  const before = redraws;
  order.value = 'oneway';
  order.dispatchEvent(new Event('change'));
  assert.equal(homeUi.order, 'oneway');
  assert.equal(redraws, before + 1);
});

test('each cue carries a rehearsal letter in its stream colour, A first', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const marks = [...sec(el, 'Cues').querySelectorAll('.qcue .rmark')].map((m) => m.textContent);
  assert.deepEqual(marks, ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, marks.length));
  assert.ok(marks.length > 1);
  assert.match([...sec(el, 'Cues').querySelectorAll('.qcue')][0]!.className, /\bsc-s/);
});

test('a stream chip narrows the asks to that stream', () => {
  const st = state();
  const stream = st.asks[0]!.stream;
  homeUi.order = 'oldest'; homeUi.stream = stream; homeUi.allAsks = false; homeUi.allShipped = false;
  const el = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, redraw: () => {} })).el;
  assert.equal(el.querySelector(`[data-ctl=chip-${stream}]`)!.getAttribute('aria-pressed'), 'true');
  const shown = sec(el, 'Cues').querySelectorAll('ask-card').length;
  assert.equal(shown, Math.min(6, st.asks.filter((a) => a.stream === stream).length));
});

const needsOf = (stream: string): import('../src/needs-items.ts').NeedsItem[] => [
  { key: 'ready:acme/widgets#7', kind: 'ready to merge', stream, repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7', title: 'Add the thing', base: 'develop', ticket: { label: 'AB-9', url: 'https://x.test/AB-9' }, summary: 'Approved by pat, checks passing, no open threads.', ageDays: 2 },
  { key: 'review:dr-00000001', kind: 'approve review', stream: 'Elsewhere', repo: 'acme/gadgets', number: 41, url: 'https://github.com/acme/gadgets/pull/41', title: 'Review of gadgets#41', author: 'robin', verdict: 'approve', summary: 'Approves: 0 blocking, 2 suggestion(s)', ageDays: 0 },
];

test('PRs ready to merge and reviews waiting for an OK are rows in Needs you, with a kind badge in words, a link, and the count includes them', () => {
  const st = state();
  homeUi.order = 'oldest'; homeUi.stream = null; homeUi.allAsks = false; homeUi.allShipped = false;
  const el = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, needs: needsOf(st.asks[0]!.stream), redraw: () => {} })).el;
  const needs = sec(el, 'Cues');
  assert.match(text(needs.querySelector('h2')), new RegExp(`${st.asks.length + 2}$`));
  const rows = [...needs.querySelectorAll('ul.needs-items > li')];
  assert.deepEqual(rows.map((r) => r.getAttribute('data-kind')), ['ready to merge', 'approve review']);
  assert.equal(text(rows[0]!.querySelector('.chip')), 'ready to merge');
  assert.equal(rows[0]!.querySelector('a[href="https://github.com/acme/widgets/pull/7"]')?.textContent, 'widgets#7 Add the thing');
  assert.match(text(rows[0]), /AB-9/);
  assert.match(text(rows[0]), /develop/);
  assert.match(text(rows[1]), /by robin/);
  assert.match(text(rows[1]), /proposed: approve/);
  assert.equal(rows[1]!.querySelector('a[href^="#tab=others"]')?.textContent, 'Open the draft');
  assert.equal(needs.querySelector('ask-card') !== null, true, 'the asks are still there');
});

test('the stream chips count and filter the new rows too', () => {
  const st = state();
  const stream = st.asks[0]!.stream;
  homeUi.order = 'oldest'; homeUi.stream = 'Elsewhere'; homeUi.allAsks = false; homeUi.allShipped = false;
  st.streams = [...st.streams, 'Elsewhere'];
  const el = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, needs: needsOf(stream), redraw: () => {} })).el;
  const needs = sec(el, 'Cues');
  assert.equal(needs.querySelectorAll('ask-card').length, 0);
  assert.deepEqual([...needs.querySelectorAll('ul.needs-items > li')].map((r) => r.getAttribute('data-kind')), ['approve review']);
  assert.match(text(needs.querySelector('[data-ctl=chip-Elsewhere]')), /Elsewhere 1/);
  homeUi.stream = null;
});

test('with no asks, rows for PRs and reviews replace the empty sentence', () => {
  const st = state();
  st.asks = [];
  homeUi.order = 'oldest'; homeUi.stream = null; homeUi.allAsks = false; homeUi.allShipped = false;
  const el = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, needs: needsOf('x'), redraw: () => {} })).el;
  assert.doesNotMatch(text(sec(el, 'Cues')), /Nothing needs you right now/);
  assert.equal(sec(el, 'Cues').querySelectorAll('ul.needs-items > li').length, 2);
});

test('the gauges say how many asks are open and how many PRs are open, with words and not colour alone', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const gauges = [...el.querySelectorAll('section.gauge')];
  assert.equal(gauges.length, 2);
  assert.match(text(gauges[0]), /Open asks by age/);
  assert.match(text(gauges[1]), /Open PRs/);
});

test('the Stream order groups the asks by stream and the choice survives a redraw', () => {
  const st = state();
  const streams = [...new Set(st.asks.map((a) => a.stream))];
  homeUi.order = 'stream'; homeUi.stream = null; homeUi.allAsks = true; homeUi.allShipped = false;
  const draw2 = (): HTMLElement => place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, redraw: () => {} })).el;
  for (const el of [draw2(), draw2()]) {
    assert.equal(el.querySelector<HTMLSelectElement>('select[data-ctl=order]')!.value, 'stream');
    const shown = [...sec(el, 'Cues').querySelectorAll('ask-card')].map((c) => (c as unknown as { ask: { stream: string } }).ask.stream);
    assert.equal(shown.length, st.asks.length);
    assert.deepEqual(shown, [...shown].sort((x, y) => x.localeCompare(y)));
  }
  assert.ok(streams.length >= 1);
});

test('a stream tab shows its library link, a quiet "No library yet." when it has none, and nothing while the projects payload is loading', () => {
  const { todayPanel } = homeSections;
  const panel = (p: ProjectsData | null, stream: string): HTMLElement => place(todayPanel([], p, stream)).el;
  const withLib = text(panel(projects(), 'acme-widgets').querySelector('[aria-label=Library]'));
  assert.equal(withLib, 'Libraryacme-widgets library');
  const link = panel(projects(), 'acme-widgets').querySelector('[aria-label=Library] a')!;
  assert.match(link.getAttribute('href') ?? '', /^obsidian:\/\/open\?vault=Sample&file=Projects%2Facme-widgets%2FINDEX$/);
  assert.ok(!panel(projects(), 'acme-widgets').querySelector('[aria-label=Notes]')!.textContent!.includes('library'), 'the library link is not repeated in Notes');
  assert.equal(text(panel(projects(), 'ops').querySelector('.library-none')), 'No library yet.');
  assert.equal(panel(null, 'ops').querySelector('.library-none, [aria-label=Library]'), null);
});

test('a stream choice nothing waits on any more narrows nothing: no staff is dimmed', () => {
  const st = state();
  const el = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, redraw: () => {} })).el;
  homeUi.stream = 'no-such-stream';
  const stale = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, redraw: () => {} })).el;
  homeUi.stream = null;
  assert.equal(stale.querySelectorAll('.staff-row.dim').length, 0);
  assert.equal(el.querySelectorAll('.staff-row.dim').length, 0);
});

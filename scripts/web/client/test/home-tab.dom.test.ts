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

test('Home reads top to bottom as score, needs you, blocked and in flight, shipped today, and every section is named by its heading', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const names = [...el.querySelectorAll('section > .sec-head h2, section > h2')].map((x) => text(x).replace(/[\s,\d]+$/, ''));
  assert.ok(names.indexOf('Needs you') > -1 && names.indexOf('Shipped today') > names.indexOf('Needs you'), names.join('|'));
  for (const s of el.querySelectorAll('section[aria-labelledby]')) assert.ok(el.querySelector(`#${s.getAttribute('aria-labelledby')}`), 'each region is named by its heading');
});

test('the score has a row per stream with a state word, and a missing charts payload says so instead of a blank', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  assert.ok(el.querySelectorAll('.score-line:not(.hd)').length >= 2, 'one row per stream');
  assert.match(text(el), /waiting on you/);
  const none = draw(state(), null, { state: 'ok', data: projects() });
  assert.match(text(none.querySelector('[role=status]')), /14-day score is missing/);
  assert.ok(sec(none, 'Needs you').querySelector('ask-card'), 'asks do not wait on the charts');
});

test('a failed projects load is an alert in place and the board is still drawn', () => {
  const el = draw(state(), charts(), { state: 'error', message: 'HTTP 500' });
  assert.match(text(el.querySelector('[role=alert]')), /Project names and notes could not be loaded \(HTTP 500\)/);
  assert.ok(sec(el, 'Needs you').querySelector('ask-card'));
});

test('while projects load nothing is announced as an error and the asks are drawn', () => {
  const el = draw(state(), charts(), { state: 'loading' });
  assert.equal(el.querySelector('[role=alert]'), null);
  assert.ok(sec(el, 'Needs you').querySelector('ask-card'));
});

test('the order control is a pressed-state toggle that asks the caller to redraw', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const oneway = el.querySelector<HTMLButtonElement>('[data-ctl=order-oneway]')!;
  assert.equal(oneway.getAttribute('aria-pressed'), 'false');
  assert.equal(el.querySelector('[data-ctl=order-oldest]')!.getAttribute('aria-pressed'), 'true');
  const before = redraws;
  oneway.click();
  assert.equal(homeUi.order, 'oneway');
  assert.equal(redraws, before + 1);
});

test('a stream chip narrows the asks to that stream', () => {
  const st = state();
  const stream = st.asks[0]!.stream;
  homeUi.order = 'oldest'; homeUi.stream = stream; homeUi.allAsks = false; homeUi.allShipped = false;
  const el = place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, redraw: () => {} })).el;
  assert.equal(el.querySelector(`[data-ctl=chip-${stream}]`)!.getAttribute('aria-pressed'), 'true');
  const shown = sec(el, 'Needs you').querySelectorAll('ask-card').length;
  assert.equal(shown, Math.min(6, st.asks.filter((a) => a.stream === stream).length));
});

test('the gauges say how many asks are open and how many PRs are open, with words and not colour alone', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  assert.match(text(el.querySelector('section.gauge')), /Open asks by age/);
  assert.match(text(el), /Open PRs/);
});

test('the Stream order groups the asks by stream and the choice survives a redraw', () => {
  const st = state();
  const streams = [...new Set(st.asks.map((a) => a.stream))];
  homeUi.order = 'stream'; homeUi.stream = null; homeUi.allAsks = true; homeUi.allShipped = false;
  const draw2 = (): HTMLElement => place(homeTab(st, charts(), { live: false, projects: { state: 'ok', data: projects() }, epics: null, redraw: () => {} })).el;
  for (const el of [draw2(), draw2()]) {
    assert.equal(el.querySelector('[data-ctl=order-stream]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(el.querySelector('[data-ctl=order-oldest]')!.getAttribute('aria-pressed'), 'false');
    const shown = [...sec(el, 'Needs you').querySelectorAll('ask-card')].map((c) => (c as unknown as { ask: { stream: string } }).ask.stream);
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

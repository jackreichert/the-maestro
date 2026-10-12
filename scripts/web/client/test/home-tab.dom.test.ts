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
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): PodiumState => structuredClone(sanitizeState(read('state.json'))!.state);
const charts = (): ChartsData => structuredClone(sanitizeCharts(read('charts.json'))!.data);
const projects = (): ProjectsData => structuredClone(sanitizeProjects(read('projects.json'))!.data);
const draw = (st: PodiumState, c: ChartsData | null, p: ProjectsLoad): HTMLElement => place(homeTab(st, c, { live: false, projects: p })).el;
const sec = (el: HTMLElement, name: string): Element => [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent?.startsWith(name))!;
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

test('five named sections in reading order: needs you, projects, done, trends, links', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const names = [...el.querySelectorAll('section h2')].map((x) => text(x).replace(/[\s,\d]+$/, ''));
  assert.deepEqual(names, ['Needs you', 'Projects', 'What we got done', 'Trends', 'Important links']);
  for (const s of el.querySelectorAll('section')) assert.ok(el.querySelector(`#${s.getAttribute('aria-labelledby')}`), 'each region is named by its heading');
});

test('project rows: the one that needs you first, a link to its tab, the state in words, and counts with nouns', () => {
  const el = draw(state(), charts(), { state: 'ok', data: projects() });
  const rows = [...sec(el, 'Projects').querySelectorAll('ul.projects > li')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector('a')?.getAttribute('href') ?? '', /^#tab=acme-widgets/);
  assert.match(text(rows[0]), /waiting on you/);
  assert.match(text(rows[0]), /2 asks · 1 in flight · 1 blocked · 2 open PRs · oldest open 5 d · 6 shipped this week/);
  assert.match(text(sec(el, 'Projects')), /As of/, 'the rows say when they were read');
});

test('while projects load, the sections that need them say so once and the rest is drawn', () => {
  const el = draw(state(), charts(), { state: 'loading' });
  const status = [...el.querySelectorAll('[role=status]')].map(text);
  assert.ok(status.includes('Loading project status…') && status.includes('Loading links…'));
  assert.ok(sec(el, 'Needs you').querySelector('ask-card'), 'asks do not wait on the projects payload');
  assert.equal(el.querySelectorAll('podium-chart').length, 1, 'the age chart comes from the board, the weekly one waits');
});

test('a failed projects load is an alert in place, not a blank page', () => {
  const el = draw(state(), charts(), { state: 'error', message: 'HTTP 500' });
  assert.match(text(sec(el, 'Projects').querySelector('[role=alert]')), /Project status could not be loaded \(HTTP 500\)/);
});

test('an empty board collapses every section to one line that says what empty means', () => {
  const st = state();
  Object.assign(st, { asks: [], working: [], blocked: [], streams: [] });
  const empty: ProjectsData = { ...projects(), rows: [], links: [], weeks: [] };
  const el = draw(st, { ...charts(), throughput: [], doneItems: [] }, { state: 'ok', data: empty });
  assert.equal(text(sec(el, 'Needs you').querySelector('p.empty')), 'Nothing needs you right now.');
  assert.match(text(sec(el, 'Projects').querySelector('p.empty')), /No projects/);
  assert.match(text(sec(el, 'What we got done').querySelector('p.empty')), /Nothing finished this week/);
  assert.match(text(sec(el, 'Important links').querySelector('p.empty')), /No links yet/);
});

test('links: web links open a new tab with noopener, vault links go to the OS, and an unsafe url is not drawn', () => {
  const p = projects();
  p.links.push({ label: 'Bad', kind: 'pin', stream: 'ops', url: 'javascript:alert(1)' });
  const el = draw(state(), charts(), { state: 'ok', data: p });
  const links = [...sec(el, 'Important links').querySelectorAll('a')];
  assert.equal(links.length, 3);
  const web = links.find((a) => a.getAttribute('href')?.startsWith('https://'))!;
  assert.equal(web.getAttribute('target'), '_blank');
  assert.match(web.getAttribute('rel') ?? '', /noopener/);
  assert.ok(links.filter((a) => a.getAttribute('href')?.startsWith('obsidian:')).every((a) => a.getAttribute('target') === null));
});

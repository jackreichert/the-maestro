// Run: node --test scripts/web/client/test/dashboard.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, place } from './dom-harness.ts';
import { sanitizeCharts, sanitizeState } from '../src/contract.ts';
import type { ChartsData, PodiumState } from '../src/types.ts';

installDom();
const { dashboardView } = await import('../src/dashboard-view.ts');
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const state = (): PodiumState => structuredClone(sanitizeState(read('state.json'))!.state);
const charts = (): ChartsData => structuredClone(sanitizeCharts(read('charts.json'))!.data);
const draw = (st: PodiumState, c: ChartsData | null, day: string | null = null, setDay: (d: string | null) => void = () => {}): HTMLElement => place(dashboardView(st, c, { day, setDay })).el;
const headings = (el: HTMLElement): string[] => [...el.querySelectorAll('section h2')].map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim());

test('four named regions, in reading order: needs you, PRs waiting, in flight, done', () => {
  const el = draw(state(), charts());
  const sections = [...el.querySelectorAll('section')];
  assert.equal(sections.length, 4);
  for (const sec of sections) {
    const label = sec.getAttribute('aria-labelledby')!;
    assert.ok(el.querySelector(`#${label}`), 'the region is named by its own heading');
  }
  assert.deepEqual(headings(el).map((t) => t.split(',')[0].replace(/\d+$/, '').trim()), ['Needs you', 'PRs waiting', 'In flight', 'Done']);
});

test('every chart mark and every list row is a link with a name and a target', () => {
  const el = draw(state(), charts());
  const marks = [...el.querySelectorAll('svg a')];
  const rows = [...el.querySelectorAll('ul.dash-rows a')];
  assert.ok(marks.length > 0 && rows.length > 0);
  for (const a of [...marks, ...rows]) {
    assert.ok(a.getAttribute('href'), `${a.outerHTML.slice(0, 80)} has a target`);
    if (a.closest('svg')) assert.ok(a.getAttribute('aria-label'), 'a mark has a real label, not just a colour');
    else assert.ok((a.textContent ?? '').trim().length > 0, 'a row has text');
  }
  for (const svg of el.querySelectorAll('svg')) {
    assert.ok(svg.querySelector('title') && svg.querySelector('desc'), 'every chart has a title and a description');
  }
});

test('links that leave the page open a new tab with noopener, and links inside the page do not', () => {
  const el = draw(state(), charts());
  for (const a of el.querySelectorAll('a[href^="https://"]')) {
    assert.equal(a.getAttribute('target'), '_blank');
    assert.match(a.getAttribute('rel') ?? '', /noopener/);
  }
  for (const a of el.querySelectorAll('a[href^="#"]')) assert.equal(a.getAttribute('target'), null);
});

test('the table view of each chart agrees with the count in its heading', () => {
  const el = draw(state(), charts());
  const sec = (name: string): Element => [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent?.startsWith(name))!;
  const sum = (s: Element, col: number): number => [...s.querySelectorAll('tbody tr')].reduce((t, tr) => t + Number(tr.querySelectorAll('td')[col]?.textContent ?? 0), 0);
  const count = (s: Element): number => Number(s.querySelector('h2 .count')?.textContent?.replace(/\D/g, '') ?? 0);
  assert.equal(sum(sec('Needs you'), 0), count(sec('Needs you')));
  assert.equal(sum(sec('In flight'), 0), count(sec('In flight')));
  const pr = sec('PRs waiting');
  assert.equal(sum(pr, 0) + sum(pr, 1), count(pr));
  const done = sec('Done');
  const last = [...done.querySelectorAll('tbody tr')].map((tr) => Number([...tr.querySelectorAll('td')].at(-1)?.textContent));
  assert.equal(last.reduce((a, b) => a + b, 0), count(done));
});

test('with nothing to show, each region says what is missing instead of drawing an empty chart', () => {
  const st = state();
  st.asks = []; st.working = []; st.prs = [];
  const c = charts();
  c.prAge = { buckets: c.prAge.buckets.map((b) => ({ ...b, inQueue: [], other: [] })), unknownAge: { inQueue: [], other: [] }, drafts: 0 };
  c.throughput = c.throughput.map((d) => ({ ...d, total: 0, byStream: {}, ids: [] }));
  const el = draw(st, c);
  const text = (el.textContent ?? '').replace(/\s+/g, ' ');
  assert.match(text, /Nothing needs you\. The next ask will appear here with its recommendation\./);
  assert.match(text, /Nothing in flight\./);
  assert.match(text, /Nothing finished in the last 14 days\./);
  assert.match(text, /No open pull requests in the snapshot\./);
  assert.equal(el.querySelectorAll('svg').length, 0);
});

test('without chart data the regions say the data is missing, and the lists that come from state still show', () => {
  const el = draw(state(), null);
  assert.ok(((el.textContent ?? '').match(/Chart data is missing/g) ?? []).length >= 3);
  assert.ok(el.querySelectorAll('ul.dash-rows a').length > 0);
});

test('a stale PR snapshot is named in the PR region with a symbol, not colour alone', () => {
  const st = state();
  st.prData = { fetchedAt: '2026-10-06T10:00:00Z', stale: true };
  st.generatedAt = '2026-10-06T14:00:00Z';
  const warn = draw(st, charts()).querySelector('.warn');
  assert.match(warn?.textContent ?? '', /PR snapshot 4 h old/);
  assert.match(warn?.textContent ?? '', /⚠/);
});

test('pressing a day column asks for that day, and an open day lists its items as links', () => {
  const c = charts();
  const day = c.throughput.find((d) => d.total > 0)!;
  let asked: string | null | undefined;
  const el = draw(state(), c, null, (d) => { asked = d; });
  const col = el.querySelector(`#done-${day.date}`) as HTMLElement;
  col.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(asked, day.date);
  const open = draw(state(), c, day.date);
  assert.equal(open.querySelector(`#done-${day.date}`)?.getAttribute('aria-expanded'), 'true');
  assert.match(open.querySelector('.day h3')?.textContent ?? '', new RegExp(day.date));
});

test('each table view is a named disclosure, so a live redraw keeps it open for a reader who opened it', () => {
  const el = draw(state(), charts());
  const folds = [...el.querySelectorAll('details.tv')].map((d) => d.getAttribute('data-fold'));
  assert.equal(folds.length, 4);
  assert.equal(new Set(folds).size, 4, 'names are unique');
  assert.ok(folds.every((f) => f && f.startsWith('dash-')));
});

test('PRs with no creation date get their own labelled dashed column, say whether they count toward the queue, and are listed', () => {
  const c = charts();
  const ref = (n: number) => ({ repo: 'acme/widgets', number: n, title: `undated ${n}`, url: `https://example.test/${n}`, stream: 'ops' });
  c.prAge = { ...c.prAge, unknownAge: { inQueue: [ref(71), ref(72)], other: [ref(73)] } };
  const el = draw(state(), c);
  const label = (n: number): string => el.querySelector(`#m-pr-acme_widgets-${n}`)?.getAttribute('aria-label') ?? '';
  assert.match(label(71), /no creation date, in the review queue$/);
  assert.match(label(73), /no creation date, not in the review queue$/);
  assert.equal(el.querySelectorAll('rect.unit.undated').length, 3, 'every undated PR is a dashed square, none an ordinary outlined one');
  assert.equal(el.querySelector('#m-pr-acme_widgets-71 rect.unit')?.getAttribute('class')?.includes('fill'), true, 'an undated PR in the queue is still filled');
  assert.ok([...el.querySelectorAll('svg text.lab')].some((t) => t.textContent === 'no date'), 'the column is labelled');
  assert.match(el.querySelector('.legend')?.textContent ?? '', /no creation date/);
  const rows = [...el.querySelectorAll('ul.dash-rows a')].map((a) => a.textContent ?? '');
  assert.ok(rows.some((r) => r.includes('undated 71') && r.includes('no date')) && rows.some((r) => r.includes('undated 72')), 'undated queue PRs are in the list');
  assert.ok(!rows.some((r) => r.includes('undated 73')), 'a self-review PR is not a queue row');
  const noDate = [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent?.startsWith('PRs waiting'))!.querySelector('tbody tr:last-child');
  assert.deepEqual([...noDate!.children].map((x) => x.textContent), ['no date', '2', '1']);
});

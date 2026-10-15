// Run: node --test scripts/web/client/test/needs-tab.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, place } from './dom-harness.ts';
import { sanitizeState } from '../src/contract.ts';
import { cueParts, scoped } from '../src/glance.ts';
import type { NeedsItem } from '../src/needs-items.ts';
import type { PodiumState } from '../src/types.ts';

installDom();
const { filteredView } = await import('../src/filter-view.ts');
const state = (): PodiumState => structuredClone(sanitizeState(JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8')))!.state);
const item = (over: Partial<NeedsItem> = {}): NeedsItem => ({ key: 'ready:acme/widgets#7', kind: 'ready to merge', stream: 'Avonlea', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7', title: 'Add the thing', base: 'develop', summary: 'Approved, checks passing, no open threads.', ...over });
const opts = (st: PodiumState, extra: NeedsItem[]) => ({ live: false, ctx: { now: st.generatedAt, tz: st.tz, showStream: true, prs: st.prs }, clear: () => {}, extra });

test('the needs-you tab lists the new rows after the asks and counts them in its heading and in the cue tile', () => {
  const st = state();
  const extra = [item(), item({ key: 'review:dr-00000001', kind: 'approve review', title: 'Review of gadgets#41', verdict: 'approve' })];
  const el = place(filteredView(scoped(st, null), 'asks', 'what needs you', opts(st, extra)) as HTMLElement).el;
  assert.equal(el.querySelectorAll('ask-card').length, st.asks.length);
  assert.deepEqual([...el.querySelectorAll('ul.needs-items > li')].map((r) => r.getAttribute('data-kind')), ['ready to merge', 'approve review']);
  assert.match((el.querySelector('h2')?.textContent ?? '').replace(/\s+/g, ' '), new RegExp(`${st.asks.length + 2}$`));
  assert.equal(cueParts(scoped(st, null), 2)[0]!.n, st.asks.length + 2);
});

test('only the asks view takes the rows; another bucket ignores them, and rows alone fill an empty asks list', () => {
  const st = state();
  const blocked = place(filteredView(scoped(st, null), 'blocked', 'blocked', opts(st, [item()])) as HTMLElement).el;
  assert.equal(blocked.querySelector('ul.needs-items'), null);
  st.asks = [];
  const alone = place(filteredView(scoped(st, null), 'asks', 'what needs you', opts(st, [item()])) as HTMLElement).el;
  assert.equal(alone.querySelectorAll('ul.needs-items > li').length, 1);
  assert.doesNotMatch(alone.textContent ?? '', /Nothing needs you right now/);
});

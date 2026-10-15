// Run: node --test scripts/web/client/test/filter-view.dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from './dom-harness.ts';
import { sanitizeState } from '../src/contract.ts';

installDom();
const { activeStream, chipId, filteredView, streamChips } = await import('../src/filter-view.ts');
const { bucketsFor } = await import('../src/glance.ts').then((m) => ({ bucketsFor: m.scoped }));
const st = sanitizeState(JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8')))!.state;

const ask = (stream: string) => ({ stream });

test('streamChips lists All first, then streams busiest first with counts, and is empty when there is nothing to narrow', () => {
  const asks = [ask('ops'), ask('beta'), ask('ops'), ask('alpha'), ask('beta'), ask('ops')];
  assert.deepEqual(streamChips(asks), [{ stream: null, n: 6 }, { stream: 'ops', n: 3 }, { stream: 'beta', n: 2 }, { stream: 'alpha', n: 1 }]);
  assert.deepEqual(streamChips([ask('ops'), ask('ops')]), []);
  assert.deepEqual(streamChips([]), []);
});

test('activeStream keeps a stream that has asks and falls back to All for anything else', () => {
  const asks = [ask('ops'), ask('beta')];
  assert.equal(activeStream(asks, 'ops'), 'ops');
  assert.equal(activeStream(asks, 'gone'), null);
  assert.equal(activeStream(asks, null), null);
  assert.equal(activeStream(asks, undefined), null);
});

test('the asks view draws pressed chips with counts and narrows the list when one is chosen', () => {
  const buckets = bucketsFor(st, null);
  const chips = streamChips(buckets.asks);
  assert.ok(chips.length > 2, 'the fixture has asks in more than one stream');
  const pick = chips[1].stream!;
  const picks: (string | null)[] = [];
  const o = { live: false, ctx: { now: st.generatedAt, tz: st.tz, showStream: true, prs: st.prs }, clear: () => {}, setStream: (s: string | null) => picks.push(s) };
  const all = filteredView(buckets, 'asks', 'need you', { ...o, stream: null }) as HTMLElement;
  const pressed = [...all.querySelectorAll('button.fchip')].filter((b) => b.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1);
  assert.match(pressed[0].textContent ?? '', /^All/);
  assert.equal(all.querySelectorAll('ask-card').length, buckets.asks.length);

  const one = filteredView(buckets, 'asks', 'need you', { ...o, stream: pick }) as HTMLElement;
  assert.equal(one.querySelectorAll('ask-card').length, chips[1].n);
  const on = [...one.querySelectorAll('button.fchip')].filter((b) => b.getAttribute('aria-pressed') === 'true');
  assert.equal(on.length, 1);
  assert.match(on[0].textContent ?? '', new RegExp(`^${pick}`));
  (one.querySelector('button.fchip') as HTMLButtonElement).click();
  assert.deepEqual(picks, [null]);

  const stale = filteredView(buckets, 'asks', 'need you', { ...o, stream: 'no-such-stream' }) as HTMLElement;
  assert.equal(stale.querySelectorAll('ask-card').length, buckets.asks.length, 'an unknown stream shows everything');
  const other = filteredView(buckets, 'blocked', 'blocked', { ...o, stream: pick }) as HTMLElement;
  assert.equal(other.querySelectorAll('button.fchip').length, 0, 'other tiles have no stream chips');
});

test('chips carry stable distinct ids, so a stream named all is not the All chip', () => {
  assert.notEqual(chipId('all'), chipId(null));
  assert.equal(chipId('a b'), 'stream-chip:a%20b');
});

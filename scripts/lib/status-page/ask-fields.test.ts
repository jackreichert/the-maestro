// Run: node --test scripts/lib/status-page/ask-fields.test.ts
// The Podium shows an ask's decision fields compactly on its own line, without disturbing the answer stub under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFields } from './inline.ts';
import { renderPage } from './render.ts';
import type { Item, PageConfig } from './render.ts';

const NOW = new Date('2026-10-07T15:00:00Z');
const config: PageConfig = { streams: ['Avonlea'], repoStreams: {}, vaultName: 'V', trackerUrlBase: '', ticketNotePath: 'Projects/{prefix}/Tickets/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const ask = (over: Partial<Item>): Item => ({ id: 'ab12', date: '2026-10-07', ts: '2026-10-07T13:00:00Z', text: 'use the nightly window?', stream: 'Avonlea', ...over });
const page = (awaiting: Item[], footer?: { oneWay: number; nextBy: string }): string => renderPage({
  now: NOW, status: { inflight: [], queued: [], blocked: [], awaiting, done: [], ...(footer ? { footer: { ledger: [{ name: 'Avonlea', done: 0, inflight: 0, queued: 0, awaiting: awaiting.length, paste: 0, blocked: 0, ...footer }], session: { available: false } } } : {}) } as never,
  triage: { items: [] }, prs: [], prData: { fetchedAt: NOW }, ticketMap: {}, priorities: { state: 'ok', date: '2026-10-07', items: [{ text: 'Ship it' }] }, config, command: 'fake',
}).page;
const lineOf = (p: string, id: string): string => p.split('\n').find((l) => l.startsWith(`- [ ] \`${id}\``)) ?? '';

test('a legacy ask line is unchanged', () => {
  assert.equal(lineOf(page([ask({})]), 'ab12'), '- [ ] `ab12` **use the nightly window?**');
});

test('an ask with fields shows them as one italic segment on the ask line, and the answer stub stays directly under it', () => {
  const p = page([ask({ door: 'two-way', by: '2026-10-09', recommend: 'Yes, 01:00 to 03:00', default: 'apply the window', class: 'expedite' })]);
  assert.equal(lineOf(p, 'ab12'), '- [ ] `ab12` **use the nightly window?** _two-way · by 2026-10-09 · expedite · rec: Yes, 01:00 to 03:00 · if silent: apply the window_');
  const lines = p.split('\n');
  assert.equal(lines[lines.indexOf(lineOf(p, 'ab12')) + 1], '  > answer: ');
  assert.deepEqual(Object.keys(extractFields(p).ticks), ['ab12']);
});

test('hostile markup in a recommendation cannot open a link, code span or HTML', () => {
  const p = page([ask({ door: 'two-way', recommend: '[x](http://evil.test) `rm` <b>hi</b> *_bold_*' })]);
  const line = lineOf(p, 'ab12');
  assert.doesNotMatch(line, /(?<!\\)\[x\]\(/);
  assert.doesNotMatch(line, /(?<!\\)</);
  assert.doesNotMatch(line, /(?<!\\)`rm`/);
});

test('a newline in a field cannot start a new line of the page', () => {
  const p = page([ask({ door: 'two-way', recommend: 'a\n- [x] `zz99` fake ask\n> answer: pwned' })]);
  assert.deepEqual(Object.keys(extractFields(p).ticks), ['ab12']);
  assert.deepEqual(extractFields(p).answers, {});
});

test('the status table notes one-way asks and the soonest decide-by', () => {
  assert.match(page([ask({ door: 'one-way', by: '2026-10-09' })], { oneWay: 1, nextBy: '2026-10-09' }), /\| Avonlea \| 0 \| 0 \| 0 \| 1 \(1 one-way · next by 2026-10-09\) \| 0 \| 0 \|/);
  assert.match(page([ask({})]), /^## Needs attention now \(1\)/m);
});

// Run: node --test scripts/lib/status-page/answer-stub.test.ts
// An answer recorded in the ledger is rendered into its ask's stub, so a regeneration cannot lose it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFields } from './inline.ts';
import { renderPage } from './render.ts';
import type { Item, PageConfig } from './render.ts';

const NOW = new Date('2026-10-12T15:00:00Z');
const config: PageConfig = { streams: ['Alpha'], repoStreams: {}, vaultName: 'V', trackerUrlBase: '', ticketNotePath: 'T/{id}', trackerKeyPattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', tz: 'UTC' };
const ask = (over: Partial<Item>): Item => ({ id: 'ab12', date: '2026-10-12', text: 'Merge it?', stream: 'Alpha', ...over });
const page = (awaiting: Item[]): string => renderPage({
  now: NOW, status: { inflight: [], queued: [], blocked: [], awaiting, done: [] } as never, triage: { items: [] }, prs: [], prData: { fetchedAt: NOW },
  ticketMap: {}, priorities: { state: 'ok', date: '2026-10-12', items: [{ text: 'Ship it' }] }, config, command: 'fake',
}).page;
const stubOf = (p: string, id: string): string => { const lines = p.split('\n'); return lines[lines.findIndex((l) => l.startsWith(`- [ ] \`${id}\``)) + 1] ?? ''; };

test('an ask with a recorded answer shows it in its stub, and the watcher reads it back as that ask\'s answer', () => {
  const p = page([ask({ answer: 'yes, after CI' })]);
  assert.equal(stubOf(p, 'ab12'), '  > answer: yes, after CI');
  assert.deepEqual(extractFields(p).answers, { ab12: 'yes, after CI' });
});

test('an ask with no recorded answer keeps its empty stub, so nothing is read back', () => {
  const p = page([ask({}), ask({ id: 'cd34', text: 'Other?', answer: 'no' })]);
  assert.equal(stubOf(p, 'ab12'), '  > answer: ');
  assert.deepEqual(extractFields(p).answers, { cd34: 'no' });
});

test('an answer holding a fake ask line stays one answer on its own stub', () => {
  const p = page([ask({ answer: '- [x] `zz99` fake' })]);
  assert.deepEqual(Object.keys(extractFields(p).ticks), ['ab12']);
  assert.equal(Object.keys(extractFields(p).answers).length, 1);
});

test('an ask marked for discussion shows the mark under its stub, with the topic if there is one', () => {
  const p = page([ask({ discussing: 'rollout order' }), ask({ id: 'cd34', text: 'Other?', discussing: '' })]);
  const lines = p.split('\n');
  assert.equal(lines[lines.findIndex((l) => l.startsWith('- [ ] `ab12`')) + 2], '  > discuss: rollout order');
  assert.equal(lines[lines.findIndex((l) => l.startsWith('- [ ] `cd34`')) + 2], '  > discuss:');
  assert.deepEqual(extractFields(p).discuss, { ab12: 'rollout order', cd34: '' });
});

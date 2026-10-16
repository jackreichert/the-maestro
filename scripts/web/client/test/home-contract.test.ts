// Run: node --test scripts/web/client/test/home-contract.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHome } from '../src/contract.ts';
import { home, ticket } from './home-fixture.ts';

test('a well-formed home base passes with nothing dropped, and unread fields do not matter', () => {
  const got = sanitizeHome(home());
  assert.equal(got?.dropped, 0);
  assert.equal(got?.home.epics.length, 2);
  assert.equal(got?.home.freshness.prs.stale, true);
});

test('a body with no usable shape is refused', () => {
  for (const x of [null, 'x', 3, [], {}, { stream: 'A' }, { stream: 'A', epics: [] }, { stream: 'A', epics: 'no', left: {} }]) assert.equal(sanitizeHome(x), null, JSON.stringify(x));
});

test('bad epics, tickets and unknowns are dropped and counted, and the rest of the tab survives', () => {
  const bad = home();
  bad.epics[0].total = '14';
  bad.left.inProgress[0].ref = 'nope';
  bad.unknowns.push({ kind: 7, text: 'x' });
  bad.loose.push(ticket('avonlea-misc-002', { awaitsYou: 'yes' }));
  const got = sanitizeHome(bad);
  assert.equal(got?.dropped, 4);
  assert.equal(got?.home.epics.length, 1);
  assert.equal(got?.home.left.inProgress.length, 0);
  assert.equal(got?.home.left.notStarted.length, 1);
});

test('an epic whose counts do not add up to its total is dropped, since its sentence would contradict its rows', () => {
  const bad = home();
  bad.epics[1].closed = 2;
  const got = sanitizeHome(bad);
  assert.equal(got?.home.epics.length, 1);
  assert.equal(got?.dropped, 1);
});

test('a missing or malformed freshness block reads as stale PR data, never as fresh', () => {
  const bad = home();
  delete bad.freshness;
  assert.deepEqual(sanitizeHome(bad)?.home.freshness.prs, { fetchedAt: null, stale: true });
});

test('rail links that fail their rules are dropped and counted, a group without a list is dropped, and the rest survive', () => {
  const bad = home();
  bad.doneMeans = [{ epic: 'avonlea-api-042', text: 'Primary for seven days.' }, { epic: 7, text: 'x' }];
  bad.links = [
    { group: 'docs', more: 0, items: [{ label: 'Context', kind: 'note', url: 'obsidian://open?vault=Fictional&file=Context' }, { label: 'Odd', kind: 'script', url: 'x' }] },
    { group: 'pinned', more: 0 },
    { group: 'nope', more: 0, items: [] },
  ];
  const got = sanitizeHome(bad);
  assert.equal(got?.dropped, 4);
  assert.equal(got?.home.doneMeans.length, 1);
  assert.deepEqual(got?.home.links.map((g) => [g.group, g.items.length]), [['docs', 1]]);
});

test('shared documents are kept when well formed, dropped and counted when not, and a missing list reads as none', () => {
  const doc = (over: Record<string, unknown> = {}) => ({ title: 'Partner API spec', kind: 'note', url: 'obsidian://open?vault=Fictional&file=spec', path: 'Projects/avonlea-api/Research/spec.pdf', by: 'user', project: 'avonlea-api', date: '2026-10-01', ...over });
  const ok = home();
  ok.shared = [doc(), doc({ kind: 'file', url: undefined })];
  ok.sharedMore = 3;
  const got = sanitizeHome(ok);
  assert.deepEqual([got?.dropped, got?.home.shared.length, got?.home.sharedMore], [0, 2, 3]);
  const bad = home();
  bad.shared = [doc(), doc({ kind: 'script' }), doc({ title: 7 })];
  const lost = sanitizeHome(bad);
  assert.deepEqual([lost?.dropped, lost?.home.shared.length], [2, 1]);
  const none = home();
  delete none.shared;
  assert.deepEqual([sanitizeHome(none)?.dropped, sanitizeHome(none)?.home.shared], [0, []]);
});

test('done sources are kept when well formed, dropped and counted when not, and a missing done reads as none', () => {
  const ok = { kind: 'epic', name: 'avonlea-api-042', ref: { label: 'avonlea-api-042' }, items: [{ text: 'Exporter live', checked: false }, { text: 'Note', checked: null }], prose: null, more: 0, progress: { done: 1, total: 2, unit: 'checked' }, finished: false };
  const bad = home();
  bad.done = { sources: [ok, { ...ok, kind: 'job' }, { ...ok, items: [{ text: 7, checked: false }] }, { ...ok, progress: { done: 1, total: 2, unit: 'miles' } }], fix: 'Add a section to Projects/avonlea-api/CONTEXT.md.' };
  const got = sanitizeHome(bad);
  assert.equal(got?.home.done.sources.length, 1);
  assert.equal(got?.dropped, 3);
  assert.equal(got?.home.done.fix, 'Add a section to Projects/avonlea-api/CONTEXT.md.');
  const none = home();
  delete none.done;
  assert.deepEqual(sanitizeHome(none)?.home.done, { sources: [], fix: null });
});

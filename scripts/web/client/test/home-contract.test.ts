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

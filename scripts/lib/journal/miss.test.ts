// Run: node --test scripts/lib/journal/miss.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missGroups, missProblems, parseMiss, pendingMisses, seenMiss, topicKey } from './miss.ts';
import type { LedgerRow } from '../ledger-core.ts';

// Built at run time so no secret-shaped literal sits in the source.
const FAKE_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const row = (over: LedgerRow): LedgerRow => ({ id: 'm1', ts: '2026-10-10T10:00:00.000Z', date: '2026-10-10', kind: 'miss', text: 'How do I rebuild the orchard index?', source: 'find', topic: topicKey('How do I rebuild the orchard index?'), repo: 'fake-repo', ...over });

test('a question and a source parse to the stored fields, with a topic key', () => {
  const r = parseMiss('  How do I rebuild\n the orchard index?  ', 'ask');
  assert.deepEqual(r.fields, { text: 'How do I rebuild the orchard index?', source: 'ask', topic: 'index orchard rebuild' });
});

test('an empty question, a bad source and a secret shape are each refused and nothing parses', () => {
  assert.match(parseMiss('  ', 'find').errors?.join() ?? '', /question is required/);
  assert.match(parseMiss('how', 'chat').errors?.join() ?? '', /--source/);
  const secret = parseMiss(`why does ${FAKE_KEY} fail`, 'find');
  assert.equal(secret.fields, undefined);
  assert.match(secret.errors?.join() ?? '', /scanner/);
  assert.ok(!(secret.errors?.join() ?? '').includes(FAKE_KEY));
  assert.match(parseMiss('x'.repeat(201), 'find').errors?.join() ?? '', /over 200/);
});

test('two phrasings of one question share a topic key', () => {
  assert.equal(topicKey('How do I rebuild the orchard index?'), topicKey('orchard index rebuild: how?'));
  assert.notEqual(topicKey('orchard index rebuild'), topicKey('harvest export schedule'));
});

test('the same question, repo and day is the same miss; another day or repo is new', () => {
  const f = parseMiss('how do i rebuild the orchard index?', 'find').fields as NonNullable<ReturnType<typeof parseMiss>['fields']>;
  assert.deepEqual(seenMiss([row({})], f, 'fake-repo', '2026-10-10'), { kind: 'same', id: 'm1' });
  assert.deepEqual(seenMiss([row({})], f, 'fake-repo', '2026-10-11'), { kind: 'new' });
  assert.deepEqual(seenMiss([row({})], f, 'other-repo', '2026-10-10'), { kind: 'new' });
});

test('a curated row closes a miss; open misses group by topic, biggest first', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', text: 'orchard index rebuild?' }), row({ id: 'c', topic: 'harvest schedule' }), { id: 'x', kind: 'curated', closes: 'a', page: 'p' }];
  assert.deepEqual(pendingMisses(rows).map((r) => r.id), ['b', 'c']);
  assert.deepEqual(missGroups(rows), [{ topic: 'harvest schedule', ids: ['c'] }, { topic: 'index orchard rebuild', ids: ['b'] }]);
});

test('verify rules: a hand-edited miss with an unknown field or a secret is flagged without echoing it', () => {
  assert.deepEqual(missProblems(row({})), []);
  assert.match(missProblems(row({ sneaky: 'x' })).join(), /never sets/);
  const bad = missProblems(row({ text: FAKE_KEY })).join();
  assert.match(bad, /scanner/);
  assert.ok(!bad.includes(FAKE_KEY));
});

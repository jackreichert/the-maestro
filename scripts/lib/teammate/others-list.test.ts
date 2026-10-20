// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/others-list.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addToList, compactList, dropFromList, listPath, mayRejoin, readList } from './others-list.ts';

const KEY = 'acme-fake/widgets#7';
const file = (): string => listPath(mkdtempSync(join(tmpdir(), 'others-list-')));

test('an empty or missing list has nothing on it', () => {
  const s = readList(file());
  assert.equal(s.active.size, 0);
  assert.equal(s.dropped.size, 0);
});

test('add is idempotent and keeps only the key, route, time, channel and author', () => {
  const f = file();
  assert.equal(addToList(f, { key: KEY, source: 'slack', channel: 'engineering', author: 'Pat F.' }, 1000), true);
  assert.equal(addToList(f, { key: KEY, source: 'manual' }, 2000), false);
  assert.deepEqual([...readList(f).active.values()], [{ key: KEY, source: 'slack', at: 1000, channel: 'engineering', author: 'Pat F.' }]);
  assert.equal(readFileSync(f, 'utf8').trim().split('\n').length, 1);
});

test('drop removes a PR, remembers why and when, and is idempotent', () => {
  const f = file();
  addToList(f, { key: KEY, source: 'manual' }, 1000);
  assert.equal(dropFromList(f, KEY, 'merged', '2026-10-19T10:00:00Z', 5000), true);
  assert.equal(dropFromList(f, KEY, 'merged', undefined, 6000), false);
  const s = readList(f);
  assert.equal(s.active.size, 0);
  assert.deepEqual(s.dropped.get(KEY), { ts: 5000, why: 'merged', updatedAt: '2026-10-19T10:00:00Z' });
});

test('a later add puts a dropped PR back', () => {
  const f = file();
  addToList(f, { key: KEY, source: 'manual' }, 1000);
  dropFromList(f, KEY, 'stale', undefined, 2000);
  addToList(f, { key: KEY, source: 'manual' }, 3000);
  assert.equal(readList(f).active.get(KEY)?.at, 3000);
  assert.equal(readList(f).dropped.has(KEY), false);
});

test('a malformed key is refused and a damaged row is skipped', () => {
  const f = file();
  assert.throws(() => addToList(f, { key: 'not a key', source: 'manual' }), /not a PR key/);
  assert.throws(() => dropFromList(f, '../x#1', 'x'), /not a PR key/);
  addToList(f, { key: KEY, source: 'manual' }, 1000);
  appendFileSync(f, '{not json\n{"op":"add","key":"bad","source":"manual","at":1,"ts":1}\n{"op":"add","key":"a/b#1","source":"carrier-pigeon","at":1,"ts":1}\n');
  assert.deepEqual([...readList(f).active.keys()], [KEY]);
});

test('a discovery re-adds a dropped PR only on news: a newer ask or a later updatedAt', () => {
  const f = file();
  addToList(f, { key: KEY, source: 'review-request' }, 1000);
  dropFromList(f, KEY, 'no activity for 2 working days', '2026-10-14T10:00:00Z', 5000);
  const s = readList(f);
  assert.equal(mayRejoin(s, KEY, { updatedAt: '2026-10-14T10:00:00Z' }), false, 'same updatedAt: still the PR that was dropped');
  assert.equal(mayRejoin(s, KEY, { updatedAt: '2026-10-15T10:00:00Z' }), true, 'a push or re-request since');
  assert.equal(mayRejoin(s, KEY, { askedAt: 4000 }), false, 'an ask older than the drop');
  assert.equal(mayRejoin(s, KEY, { askedAt: 6000 }), true, 'a new Slack ask');
  assert.equal(mayRejoin(s, 'acme-fake/widgets#8', {}), true, 'never seen');
  addToList(f, { key: 'acme-fake/widgets#8', source: 'manual' }, 7000);
  assert.equal(mayRejoin(readList(f), 'acme-fake/widgets#8', { askedAt: 9999 }), false, 'already listed');
});

test('compaction rewrites to the fold and changes nothing a reader sees', () => {
  const f = file();
  for (let i = 0; i < 30; i += 1) { addToList(f, { key: KEY, source: 'manual' }, 1000 + i * 10); dropFromList(f, KEY, 'stale', '2026-10-14T10:00:00Z', 1005 + i * 10); }
  addToList(f, { key: 'acme-fake/widgets#9', source: 'twin' }, 2000);
  const before = readList(f);
  assert.equal(compactList(f, 3000), true);
  const after = readList(f);
  assert.deepEqual([...after.active], [...before.active]);
  assert.deepEqual([...after.dropped], [...before.dropped]);
  assert.equal(after.rows, 2);
  assert.equal(compactList(f, 3000), false, 'a small file is left alone');
});

test('keys compare case-insensitively: the same PR named two ways is one entry', () => {
  const f = file();
  assert.equal(addToList(f, { key: 'Acme-Fake/Widgets#7', source: 'manual' }, 1000), true);
  assert.equal(addToList(f, { key: 'acme-fake/widgets#7', source: 'slack' }, 2000), false);
  assert.deepEqual([...readList(f).active.keys()], ['acme-fake/widgets#7']);
  assert.equal(dropFromList(f, 'ACME-FAKE/WIDGETS#7', 'merged', undefined, 3000), true);
  assert.equal(mayRejoin(readList(f), 'Acme-Fake/Widgets#7', { askedAt: 2500 }), false);
});

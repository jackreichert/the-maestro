// Run: node --test scripts/lib/whats-next/tracker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTracker, MAX_ITEMS, readTracker, TRACKER_FILE, writeTracker } from './tracker.ts';

const AT = new Date('2026-10-13T12:00:00Z');
const opts = { source: 'jira', fetchedAt: AT };

test('a search result with nested fields and named status and priority is normalised; the description only sets doneLooksLike', () => {
  const raw = { issues: [{ key: 'ZZ-1', fields: { summary: '  Light the\nlamps  ', status: { name: 'To Do' }, priority: { name: 'High' }, labels: ['shire', 3], created: '2026-09-01T00:00:00Z', description: '## What done looks like\n- lit' } }] };
  const { snapshot, withheld, skipped } = importTracker(raw, opts);
  assert.deepEqual(snapshot, { fetchedAt: AT.toISOString(), source: 'jira', items: [{ key: 'ZZ-1', title: 'Light the lamps', status: 'To Do', priority: 'High', labels: ['shire'], created: '2026-09-01T00:00:00Z', doneLooksLike: true }] });
  assert.deepEqual([withheld, skipped], [[], []]);
  assert.ok(!JSON.stringify(snapshot).includes('lit'), 'the description is never stored');
});

test('the snapshot\'s own shape and a bare array are accepted; a bad key is skipped and named; a duplicate key keeps the last', () => {
  const own = importTracker({ items: [{ key: 'ZZ-2', title: 'a', status: 'Open', priority: 'Low', labels: [], url: 'https://example.test/ZZ-2' }] }, opts);
  assert.equal(own.snapshot.items[0]!.url, 'https://example.test/ZZ-2');
  const arr = importTracker([{ key: 'zz-3' }, { key: 'ZZ-4', summary: 'first' }, { key: 'ZZ-4', summary: 'second', url: 'javascript:alert(1)' }, 'nope'], opts);
  assert.deepEqual(arr.snapshot.items.map((i) => [i.key, i.title, i.url]), [['ZZ-4', 'second', undefined]]);
  assert.deepEqual(arr.skipped, ['#1: key "zz-3" is not a tracker key', '#4: not an object']);
});

test('a title the scanner flags is replaced before anything is written, and the key is reported', () => {
  const { snapshot, withheld } = importTracker({ issues: [{ key: 'ZZ-5', summary: ['write to bilbo', '@', 'bagend.test'].join('') }] }, opts);
  assert.deepEqual(withheld, ['ZZ-5']);
  assert.match(snapshot.items[0]!.title, /^\(title withheld: title: looks like PHI \(email-address\)\)$/);
  assert.ok(!JSON.stringify(snapshot).includes('bagend'));
});

test('long titles are clipped to one line; a missing title falls back to the key', () => {
  const { snapshot } = importTracker([{ key: 'ZZ-6', summary: 'x'.repeat(500) }, { key: 'ZZ-7' }], opts);
  assert.equal(snapshot.items[0]!.title.length, 200);
  assert.equal(snapshot.items[1]!.title, 'ZZ-7');
  assert.equal(snapshot.items[1]!.status, 'open');
});

test('a shape that is not a list, too many issues, or a bad source is refused', () => {
  assert.throws(() => importTracker({ total: 3 }, opts), /expected an array of issues/);
  assert.throws(() => importTracker(Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ key: `ZZ-${i + 1}` })), opts), /over the cap/);
  assert.throws(() => importTracker([], { source: 'Jira Cloud!', fetchedAt: AT }), /--source/);
});

test('write then read round-trips; a damaged or missing file reads as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-'));
  assert.equal(readTracker(dir), null);
  const { snapshot } = importTracker([{ key: 'ZZ-8', summary: 'mend the fence' }], opts);
  writeTracker(dir, snapshot);
  assert.deepEqual(readTracker(dir), snapshot);
  writeFileSync(join(dir, TRACKER_FILE), '{"fetchedAt":"2026-10-13","source":"jira","items":[{"key":"bad"}]}');
  assert.equal(readTracker(dir), null);
  writeFileSync(join(dir, TRACKER_FILE), 'not json');
  assert.equal(readTracker(dir), null);
});

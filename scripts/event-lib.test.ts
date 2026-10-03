// Run: node --test scripts/notify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PER_TICK, MAX_SUMMARY, notify, oneLine } from './lib/notify.ts';
import { acquireLock, addWatch, listWatches, readDigest, removeWatch } from './lib/watch-registry.ts';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ev = (n: number) => ({ watch: `w${n}`, summary: `thing ${n}` });

test('the summary is appended as the last argument, without a shell', () => {
  const calls: [string, string[]][] = [];
  notify([ev(1)], ['sender', '--flag'], (c, a) => { calls.push([c, a]); return { status: 0 }; });
  assert.deepEqual(calls, [['sender', ['--flag', 'w1: thing 1']]]);
});

test('no command or no events sends nothing', () => {
  const run = () => assert.fail('must not run');
  assert.deepEqual(notify([ev(1)], [], run), []);
  assert.deepEqual(notify([], ['x'], run), []);
});

test('a long or multi-line summary becomes one line under 150 characters', () => {
  const line = oneLine(`first\nsecond ${'x'.repeat(400)}`);
  assert.equal(line.length <= MAX_SUMMARY, true);
  assert.equal(line.includes('\n'), false);
});

test('a burst is capped, with one overflow line', () => {
  const sent = notify([1, 2, 3, 4, 5].map(ev), ['s'], () => ({ status: 0 }));
  assert.equal(sent.length, MAX_PER_TICK + 1);
  assert.match(sent.at(-1) ?? '', /\+2 more/);
});

test('a failing notifier is reported and never throws', () => {
  assert.deepEqual(notify([ev(1)], ['s'], () => ({ status: 1 })), []);
  assert.deepEqual(notify([ev(1)], ['s'], () => ({ error: new Error('ENOENT') })), []);
});

const dir = () => mkdtempSync(join(tmpdir(), 'registry-test-'));

test('the registry is append-only: remove adds a tombstone, and re-adding a removed id works', () => {
  const d = dir();
  addWatch(d, { id: 'a', type: 't', target: 'x' });
  assert.equal(removeWatch(d, 'a'), true);
  assert.equal(removeWatch(d, 'a'), false);
  assert.deepEqual(listWatches(d), []);
  addWatch(d, { id: 'a', type: 't', target: 'y' });
  assert.equal(listWatches(d)[0].target, 'y');
});

test('a corrupt registry or digest line is skipped, not fatal', () => {
  const d = dir();
  addWatch(d, { id: 'a', type: 't', target: 'x' });
  appendFileSync(join(d, 'watches.jsonl'), 'not json\n');
  appendFileSync(join(d, 'digest.jsonl'), '{"watch":"a"}\ngarbage\n');
  assert.equal(listWatches(d).length, 1);
  assert.equal(readDigest(d).length, 1);
});

test('a watch interval is stored, and anything but a positive number is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-lib-'));
  assert.equal(addWatch(dir, { id: 'a', type: 't', target: 'x', interval: '90' }).interval, 90);
  assert.equal(addWatch(dir, { id: 'b', type: 't', target: 'x' }).interval, null);
  for (const bad of ['0', '-5', 'soon', '', 'Infinity', '1e400']) assert.throws(() => addWatch(dir, { id: 'c', type: 't', target: 'x', interval: bad }), /interval/);
});

test('ids are validated and defaults are filled in', () => {
  const d = dir();
  assert.throws(() => addWatch(d, { id: '../x', type: 't', target: 'x' }), /watch id/);
  assert.throws(() => addWatch(d, { id: 'ok', type: 't' }), /--type and --target/);
  const w = addWatch(d, { id: 'ok', type: 't', target: 'x' }, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(w.expires, '2026-10-02T00:00:00.000Z');
  assert.equal(w.notify_overnight, false);
});

test('the lock refuses a live owner, and is taken over from a dead one or junk', () => {
  const d = dir();
  const file = acquireLock(d, 4000000);
  assert.equal(readFileSync(file, 'utf8'), '4000000');
  writeFileSync(file, String(process.pid));
  assert.throws(() => acquireLock(d), /another event loop is running/);
  writeFileSync(file, '99999999');
  assert.doesNotThrow(() => acquireLock(d, 4000001));
  writeFileSync(file, 'junk');
  assert.doesNotThrow(() => acquireLock(d, 4000002));
});

test('a digest summary can run longer than a notification', () => {
  assert.equal(oneLine('x'.repeat(400), 300).length, 300);
});

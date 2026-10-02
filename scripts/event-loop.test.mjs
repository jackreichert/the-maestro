// Run: node --test scripts/event-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, formatDigest, pace, tick } from './event-loop.mjs';
import { addWatch, listWatches, loadState, readDigest } from './lib/watch-registry.mjs';

const SCRIPT = new URL('./event-loop.mjs', import.meta.url).pathname;
const tempDir = () => mkdtempSync(join(tmpdir(), 'event-loop-test-'));
const NOON = Date.parse('2026-10-01T12:00:00Z');
const NIGHT = Date.parse('2026-10-01T22:00:00Z');
const MIN = 60000;
const OPEN = { quietHours: '20:00-07:00', quietMode: 'stop', tz: 'UTC' };
const ALWAYS = { quietHours: 'off', tz: 'UTC' };

// A counter type: check reads the target's number from ctx; an event fires when it grows; done at 3.
const counter = (values) => ({
  check: (target) => ({ n: values[target], done: values[target] >= 3 }),
  diff: (prev, next) => (prev && next.n > prev.n ? [{ summary: `n is ${next.n}` }] : []),
});
const base = (dir, types, extra = {}) => ({ dir, types, config: ALWAYS, now: NOON, ...extra });

test('a first check records state and emits nothing; a change emits one event', () => {
  const dir = tempDir();
  const values = { a: 1 };
  addWatch(dir, { id: 'w1', type: 'counter', target: 'a', report: 'say the number' }, NOON);
  const types = { counter: counter(values) };
  assert.deepEqual(tick(base(dir, types)).events, []);
  values.a = 2;
  const { events } = tick(base(dir, types, { now: NOON + 5 * MIN }));
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /n is 2/);
  assert.equal(events[0].actionable, true);
  assert.equal(events[0].report, 'say the number');
  assert.equal(readDigest(dir).length, 1);
});

test('an unchanged state stays silent however many ticks pass', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'w1', type: 'counter', target: 'a' }, NOON);
  const types = { counter: counter({ a: 1 }) };
  for (let i = 0; i < 4; i++) assert.deepEqual(tick(base(dir, types, { now: NOON + i * 5 * MIN })).events, []);
  assert.deepEqual(readDigest(dir), []);
});

test('a watch whose type says done retires after its final event', () => {
  const dir = tempDir();
  const values = { a: 2 };
  addWatch(dir, { id: 'w1', type: 'counter', target: 'a' }, NOON);
  const types = { counter: counter(values) };
  tick(base(dir, types));
  values.a = 3;
  const out = tick(base(dir, types, { now: NOON + 5 * MIN }));
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.retired, [{ id: 'w1', reason: 'done' }]);
  assert.deepEqual(listWatches(dir), []);
  assert.equal(loadState(dir).watches.w1, undefined);
});

test('an expired watch retires with one actionable event and is not checked', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'w1', type: 'counter', target: 'a', ttlMs: MIN }, NOON);
  const types = { counter: { check: () => { throw new Error('must not run'); }, diff: () => [] } };
  const out = tick(base(dir, types, { now: NOON + 2 * MIN }));
  assert.deepEqual(out.retired, [{ id: 'w1', reason: 'expired' }]);
  assert.match(out.events[0].summary, /expired/);
  assert.equal(out.events[0].actionable, true);
  assert.deepEqual(listWatches(dir), []);
});

test('a failing check speaks once after three failures in a row, then recovers silently', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'w1', type: 'bad', target: 'a' }, NOON);
  let fail = true;
  const types = { bad: { check: () => { if (fail) throw new Error('boom\nsecond line'); return { n: 1 }; }, diff: () => [] } };
  const seen = [1, 2, 3, 4].map((i) => tick(base(dir, types, { now: NOON + i * 5 * MIN })).events.length);
  assert.deepEqual(seen, [0, 0, 1, 0]);
  assert.match(readDigest(dir)[0].summary, /keeps failing: boom$/);
  fail = false;
  tick(base(dir, types, { now: NOON + 10 * 5 * MIN }));
  assert.equal(loadState(dir).watches.w1.errors, 0);
});

test('an unknown type counts as a failing check, not a crash', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'w1', type: 'nope', target: 'a' }, NOON);
  assert.doesNotThrow(() => tick(base(dir, {})));
  assert.equal(loadState(dir).watches.w1.errors, 1);
});

test('informational events are digested but not notified', () => {
  const dir = tempDir();
  const sent = [];
  const types = { t: { check: () => ({ n: 1 }), diff: () => [{ summary: 'fyi', actionable: false }, { summary: 'act' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  tick(base(dir, types, { notifyCommand: ['send', '--to-self'], notifyRun: (c, a) => { sent.push([c, a]); return { status: 0 }; } }));
  assert.deepEqual(sent, [['send', ['--to-self', 'w1: act']]]);
  assert.equal(readDigest(dir).length, 2);
});

test('no notify command means no notification and no error', () => {
  const dir = tempDir();
  const types = { t: { check: () => ({}), diff: () => [{ summary: 'act' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  assert.equal(tick(base(dir, types, { notifyRun: () => { throw new Error('must not run'); } })).events.length, 1);
});

test('quiet hours skip ordinary watches and still check notify_overnight ones', () => {
  const dir = tempDir();
  const checked = [];
  const types = { t: { check: (target) => { checked.push(target); return {}; }, diff: () => [] } };
  addWatch(dir, { id: 'day', type: 't', target: 'day' }, NIGHT);
  addWatch(dir, { id: 'night', type: 't', target: 'night', notify_overnight: true }, NIGHT);
  const out = tick(base(dir, types, { config: OPEN, now: NIGHT + MIN }));
  assert.deepEqual(checked, ['night']);
  assert.deepEqual(out.skipped, ['day']);
});

test('quiet hours do not notify for an ordinary watch that expires overnight, but do for notify_overnight', () => {
  const dir = tempDir();
  const sent = [];
  const notifyRun = (c, a) => { sent.push(a.at(-1)); return { status: 0 }; };
  addWatch(dir, { id: 'day', type: 't', target: 'x', ttlMs: MIN }, NIGHT - 10 * MIN);
  addWatch(dir, { id: 'night', type: 't', target: 'y', ttlMs: MIN, notify_overnight: true }, NIGHT - 10 * MIN);
  tick(base(dir, { t: { check: () => ({}), diff: () => [] } }, { config: OPEN, now: NIGHT, notifyCommand: ['n'], notifyRun }));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^night:/);
});

test('cadence: floor of 300s, quiet-hours stop, and an overnight watch keeps the loop going', () => {
  const dir = tempDir();
  const cfg = (c) => ({ ...c, minInterval: 60 });
  assert.equal(pace({ dir, config: cfg(ALWAYS), now: NOON }).seconds >= 300, true);
  assert.equal(pace({ dir, config: cfg(OPEN), now: NIGHT }).stop, true);
  addWatch(dir, { id: 'n', type: 't', target: 'y', notify_overnight: true }, NIGHT);
  const next = pace({ dir, config: cfg(OPEN), now: NIGHT });
  assert.equal(next.stop, undefined);
  assert.equal(next.seconds >= 300, true);
});

test('events feed the cadence: a burst of events holds the loop at the floor', () => {
  const dir = tempDir();
  const types = { t: { check: () => ({}), diff: () => [{ summary: 'a' }, { summary: 'b' }, { summary: 'c' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  tick(base(dir, types));
  assert.equal(pace({ dir, config: ALWAYS, now: NOON }).seconds, 300);
});

test('formatDigest lists actionable events first and carries the report hint only on those', () => {
  const text = formatDigest([
    { watch: 'a', type: 't', summary: 'fyi', actionable: false, report: '' },
    { watch: 'b', type: 't', summary: 'go', actionable: true, report: 'name the PR' },
  ]);
  assert.equal(text, 'ACTION b (t): go | report: name the PR\ninfo a (t): fyi');
});

const cli = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir, MAESTRO_WATCH_QUIET_HOURS: 'off' },
});

test('cli: run --once against an empty registry exits 0 cleanly', () => {
  const r = cli(tempDir(), 'run', '--once');
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /no watches registered/);
});

test('cli: add, list and remove round-trip, and a duplicate id is refused', () => {
  const dir = tempDir();
  assert.equal(cli(dir, 'add', '--id', 'w1', '--type', 't', '--target', 'x').status, 0);
  assert.equal(cli(dir, 'add', '--id', 'w1', '--type', 't', '--target', 'x').status, EXIT.usage);
  assert.match(cli(dir, 'list').stdout, /^w1\tt\tx/);
  assert.match(cli(dir, 'remove', 'w1').stdout, /removed w1/);
  assert.match(cli(dir, 'list').stdout, /no watches registered/);
  assert.equal(cli(dir, 'add', '--id', 'bad id', '--type', 't', '--target', 'x').status, EXIT.usage);
  assert.equal(cli(dir, 'add', '--id', 'w2', '--type', 't', '--target', 'x', '--ttl-hours', '0').status, EXIT.usage);
});

test('cli: run --once with an unknown-type watch does not crash and reports nothing actionable', () => {
  const dir = tempDir();
  cli(dir, 'add', '--id', 'w1', '--type', 'nope', '--target', 'x');
  const r = cli(dir, 'run', '--once');
  assert.equal(r.status, EXIT.ok, r.stderr);
  assert.match(r.stdout, /no actionable events/);
});

test('cli: digest consumes what it prints; --peek does not', () => {
  const dir = tempDir();
  const types = { t: { check: () => ({}), diff: () => [{ summary: 'act' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  tick(base(dir, types));
  assert.match(cli(dir, 'digest', '--peek').stdout, /ACTION w1/);
  assert.match(cli(dir, 'digest').stdout, /ACTION w1/);
  assert.match(cli(dir, 'digest').stdout, /digest is empty/);
});

test('cli: a second loop is refused while one holds the lock', () => {
  const dir = tempDir();
  cli(dir, 'add', '--id', 'w1', '--type', 'nope', '--target', 'x');
  writeFileSync(join(dir, 'loop.lock'), String(process.pid));
  const r = cli(dir, 'run', '--once');
  assert.equal(r.status, EXIT.usage);
  assert.match(r.stderr, /another event loop is running/);
});

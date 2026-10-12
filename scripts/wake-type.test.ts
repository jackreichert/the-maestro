// Run: node --test scripts/wake-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as wake from './event-types/wake.ts';
import { addWatch, listWatches, readDigest } from './lib/watch-registry.ts';
import type { NotifyRun } from './lib/notify.ts';
import { cleanEnv } from './lib/test-env.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const T0 = Date.parse('2026-10-03T12:00:00Z');
const MIN = 60000;
const NO_CMD = { run: () => { throw new Error('a wake must not run commands'); } };
const setup = () => ({ dir: mkdtempSync(join(tmpdir(), 'wake-')), types: { wake }, config: { quietHours: 'off' }, ctx: NO_CMD });

test('wake is registered and its playbook opens with what it does', () => {
  assert.equal(BUILTIN_TYPES.wake, wake);
  assert.match(readFileSync(join(ROOT, 'playbooks', 'event-types', 'wake.md'), 'utf8'), /^# Event type: wake\n\n## What this does\n/);
});

test('targets: hourly minutes parse sorted and unique; a bad minute, bad time or past time is refused', () => {
  assert.deepEqual(wake.parseHourly('hourly:37,7,7'), [7, 37]);
  assert.equal(wake.parseHourly('2026-10-03T15:00:00Z'), null);
  assert.throws(() => wake.parseHourly('hourly:60'), /minute outside/);
  assert.throws(() => wake.validate('hourly:', { now: T0 }), /wake target/);
  assert.throws(() => wake.validate('tomorrow', { now: T0 }), /wake target/);
  assert.throws(() => wake.validate('2026-02-30T10:00:00Z', { now: T0 }), /not a real date/);
  assert.throws(() => wake.validate('2026-10-03T11:00:00Z', { now: T0 }), /in the past/);
  assert.throws(() => wake.validate('2026-10-05T12:00:00Z', { now: T0, ttlMs: 3600000 }), /expire the wake/);
  assert.doesNotThrow(() => wake.validate('hourly:7,37', { now: T0, ttlMs: 3600000 }));
  assert.ok(wake.defaultTtlMs('2026-10-10T12:00:00Z', T0) > 7 * 24 * 3600 * 1000);
  assert.equal(wake.defaultTtlMs('hourly:7', T0), 24 * 3600 * 1000);
});

test('hourly: the first check is a baseline and does not fire; each later slot fires once', () => {
  const { dir, types, config, ctx } = setup();
  addWatch(dir, { id: 'h', type: 'wake', target: 'hourly:7,37', report: 'work the queue' }, T0);
  const at = (min: number) => tick({ dir, types, config, ctx, now: T0 + min * MIN });
  assert.deepEqual(at(1).events, []);
  assert.deepEqual(at(5).events, []);
  const first = at(8);
  assert.deepEqual(first.events.map((e) => [e.summary, e.actionable, e.report]), [['wake: work the queue', true, 'work the queue']]);
  assert.deepEqual(at(20).events, []);
  assert.equal(at(38).events.length, 1);
  assert.deepEqual(first.retired, []);
  assert.equal(listWatches(dir).length, 1, 'a recurring wake stays registered');
});

test('hourly: slots missed while the loop was down fold into one event', () => {
  const { dir, types, config, ctx } = setup();
  addWatch(dir, { id: 'h', type: 'wake', target: 'hourly:7,37', report: 'go' }, T0);
  tick({ dir, types, config, ctx, now: T0 + MIN });
  const out = tick({ dir, types, config, ctx, now: T0 + 5 * 3600 * 1000 + MIN });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].summary, 'wake: go (10 wake times passed)');
});

test('one-shot: silent before the target, one event at it, then retired and never again', () => {
  const { dir, types, config, ctx } = setup();
  addWatch(dir, { id: 'w', type: 'wake', target: '2026-10-03T12:10:00Z', report: 'stand up' }, T0);
  const at = (min: number) => tick({ dir, types, config, ctx, now: T0 + min * MIN });
  assert.deepEqual(at(0).events, []);
  const fired = at(11);
  assert.deepEqual(fired.events.map((e) => e.summary), ['wake: stand up']);
  assert.deepEqual(fired.retired, [{ id: 'w', reason: 'done' }]);
  assert.deepEqual(at(60).events, []);
  assert.equal(readDigest(dir).length, 1);
});

test('quiet hours hold a wake until morning, folded into one, unless --notify-overnight', () => {
  const evening = Date.parse('2026-10-03T19:30:00Z');
  const config = { quietHours: '20:00-07:00', quietMode: 'stop', tz: 'UTC' };
  const { dir, types, ctx } = setup();
  addWatch(dir, { id: 'held', type: 'wake', target: 'hourly:7', report: 'a' }, evening);
  addWatch(dir, { id: 'through', type: 'wake', target: 'hourly:7', report: 'b', notify_overnight: true }, evening);
  tick({ dir, types, config, ctx, now: evening });
  const out = tick({ dir, types, config, ctx, now: evening + 3 * 3600 * 1000 });
  assert.deepEqual(out.events.map((e) => e.watch), ['through']);
  assert.deepEqual(out.skipped, ['held']);
  const morning = tick({ dir, types, config, ctx, now: Date.parse('2026-10-04T07:30:00Z') });
  assert.ok(morning.events.some((e) => e.watch === 'held' && /\(\d+ wake times passed\)/.test(e.summary)), 'the held wake folds its missed slots into one event');
  assert.equal(morning.events.filter((e) => e.watch === 'held').length, 1);
});

test('a wake never notifies, even when the registry is hand-edited to say notify:true', () => {
  const { dir, types, config, ctx } = setup();
  addWatch(dir, { id: 'w', type: 'wake', target: 'hourly:7', report: 'x', notify: true, notify_overnight: true }, T0);
  const sent: string[][] = [];
  const notifyRun: NotifyRun = (cmd, args) => { sent.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
  tick({ dir, types, config, ctx, now: T0 + MIN, notifyCommand: ['/usr/bin/true'], notifyRun });
  const out = tick({ dir, types, config, ctx, now: T0 + 8 * MIN, notifyCommand: ['/usr/bin/true'], notifyRun });
  assert.equal(out.events.length, 1);
  assert.deepEqual(sent, []);
});

test('cli: add stores hourly and future one-shot wakes, refuses bad ones and --notify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'event-loop.ts'), ...args], { encoding: 'utf8', env: { ...cleanEnv(), MAESTRO_EVENT_DIR: dir } });
  const add = (id: string, target: string, ...more: string[]) => cli('add', '--id', id, '--type', 'wake', '--target', target, '--report', 'x', ...more);
  assert.equal(add('a', 'hourly:7,37').status, 0);
  assert.equal(add('b', 'hourly:99').status, 2);
  assert.match(add('c', '2020-01-01T00:00:00Z').stderr, /in the past/);
  assert.notEqual(add('d', 'hourly:7', '--notify').status, 0);
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  assert.equal(add('e', future).status, 0);
  assert.deepEqual(JSON.parse(cli('list', '--json').stdout).map((w: { id: string; notify: boolean }) => [w.id, w.notify]), [['a', false], ['e', false]]);
});

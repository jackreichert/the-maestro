// Run: node --test scripts/event-loop.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, drainDigestToInbox, formatDigest, pace, tick } from './event-loop.ts';
import type { TickDeps } from './event-loop.ts';
import type { TypeRegistry } from './event-types/index.ts';
import type { Interval, Stop } from './lib/cadence.ts';
import type { CheckContext, EventType, Watch } from './lib/types.ts';
import * as inbox from './event-types/inbox.ts';
import * as prChecks from './event-types/pr-checks.ts';
import * as reminder from './event-types/reminder.ts';
import { notifyChoice } from './lib/notify.ts';
import { appendEvents, readInbox } from './lib/event-inbox.ts';
import { acquireLock, addWatch, appendDigest, listWatches, loadState, readDigest } from './lib/watch-registry.ts';

const SCRIPT = new URL('./event-loop.ts', import.meta.url).pathname;
const tempDir = () => mkdtempSync(join(tmpdir(), 'event-loop-test-'));
const NOON = Date.parse('2026-10-01T12:00:00Z');
const NIGHT = Date.parse('2026-10-01T22:00:00Z');
const MIN = 60000;
const OPEN = { quietHours: '20:00-07:00', quietMode: 'stop', tz: 'UTC' };
const ALWAYS = { quietHours: 'off', tz: 'UTC' };

// A counter type: check reads the target's number from ctx; an event fires when it grows; done at 3.
const counter = (values: Record<string, number>): EventType<{ n: number; done: boolean }> => ({
  check: (target) => ({ n: values[target], done: values[target] >= 3 }),
  diff: (prev, next) => (prev && next.n > prev.n ? [{ summary: `n is ${next.n}` }] : []),
});
const secondsOf = (r: Interval | Stop): number | undefined => ('seconds' in r ? r.seconds : undefined);
const stopOf = (r: Interval | Stop): true | undefined => ('stop' in r ? r.stop : undefined);
const prChecksType: EventType = prChecks;
const base = (dir: string, types: TypeRegistry, extra: Partial<TickDeps> = {}): TickDeps => ({ dir, types, config: ALWAYS, now: NOON, ...extra });

test('a first check records state and emits nothing; a change emits one event', () => {
  const dir = tempDir();
  const values = { a: 1 };
  addWatch(dir, { id: 'w1', type: 'counter', target: 'a', report: 'say the number' }, NOON);
  const types: TypeRegistry = { counter: counter(values) };
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
  const types: TypeRegistry = { counter: counter({ a: 1 }) };
  for (let i = 0; i < 4; i++) assert.deepEqual(tick(base(dir, types, { now: NOON + i * 5 * MIN })).events, []);
  assert.deepEqual(readDigest(dir), []);
});

test('a watch whose type says done retires after its final event', () => {
  const dir = tempDir();
  const values = { a: 2 };
  addWatch(dir, { id: 'w1', type: 'counter', target: 'a' }, NOON);
  const types: TypeRegistry = { counter: counter(values) };
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
  const types: TypeRegistry = { counter: { check: () => { throw new Error('must not run'); }, diff: () => [] } };
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
  const types: TypeRegistry = { bad: { check: () => { if (fail) throw new Error('boom\nsecond line'); return { n: 1 }; }, diff: () => [] } };
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
  const sent: [string, string[]][] = [];
  const types: TypeRegistry = { t: { check: () => ({ n: 1 }), diff: () => [{ summary: 'fyi', actionable: false }, { summary: 'act' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a', notify: true }, NOON);
  tick(base(dir, types, { notifyCommand: ['send', '--to-self'], notifyRun: (c, a) => { sent.push([c, a]); return { status: 0 }; } }));
  assert.deepEqual(sent, [['send', ['--to-self', 'w1: act']]]);
  assert.equal(readDigest(dir).length, 2);
});

test('notify is opt-in per watch: only a watch added with notify reaches notify_command', () => {
  const dir = tempDir();
  const sent: (string | undefined)[] = [];
  const types: TypeRegistry = { t: { check: () => ({}), diff: () => [{ summary: 'act' }] } };
  addWatch(dir, { id: 'quiet', type: 't', target: 'a' }, NOON);
  addWatch(dir, { id: 'loud', type: 't', target: 'a', notify: true }, NOON);
  const out = tick(base(dir, types, { notifyCommand: ['send'], notifyRun: (c, a) => { sent.push(a.at(-1)); return { status: 0 }; } }));
  assert.deepEqual(sent, ['loud: act']);
  assert.equal(out.events.length, 2, 'both still reach the digest');
  assert.equal(readDigest(dir).length, 2);
});

test('the inbox type never notifies, even if its watch record says notify', () => {
  const dir = tempDir();
  const sent: string[][] = [];
  const types: TypeRegistry = { inbox: { ...inbox, check: () => ({ ids: ['a'] }), diff: () => [{ summary: '1 new message(s) from user' }] } };
  addWatch(dir, { id: 'in', type: 'inbox', target: 'inbox', notify: true }, NOON);
  tick(base(dir, types, { notifyCommand: ['send'], notifyRun: (c, a) => { sent.push(a); return { status: 0 }; } }));
  assert.deepEqual(sent, []);
  assert.equal(readDigest(dir).length, 1);
});

test('a reminder notifies by default and not with --no-notify; the choice is stored at add', () => {
  assert.equal(notifyChoice(reminder, {}), true);
  assert.equal(notifyChoice(reminder, { noNotify: true }), false);
  assert.equal(notifyChoice(prChecksType, {}), false);
  assert.equal(notifyChoice(prChecksType, { notify: true }), true);
  assert.equal(notifyChoice(inbox, {}), false);
  assert.throws(() => notifyChoice(inbox, { notify: true }), /never notifies/);
  assert.throws(() => notifyChoice(prChecksType, { notify: true, noNotify: true }), /cannot be used together/);
  assert.equal(notifyChoice(undefined, {}), false, 'an unknown type is opt-in');
});

test('cli: add stores notify from the flags and the type default', () => {
  const dir = tempDir();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  assert.equal(cli(dir, 'add', '--id', 'plain', '--type', 'pr-checks', '--target', 'o/r#1').status, 0);
  assert.equal(cli(dir, 'add', '--id', 'loud', '--type', 'pr-checks', '--target', 'o/r#2', '--notify').status, 0);
  assert.equal(cli(dir, 'add', '--id', 'rem', '--type', 'reminder', '--target', future).status, 0);
  assert.equal(cli(dir, 'add', '--id', 'rem2', '--type', 'reminder', '--target', future, '--no-notify').status, 0);
  assert.equal(cli(dir, 'add', '--id', 'in', '--type', 'inbox', '--target', 'inbox', '--notify').status, EXIT.usage);
  assert.equal(cli(dir, 'add', '--id', 'both', '--type', 'pr-checks', '--target', 'o/r#3', '--notify', '--no-notify').status, EXIT.usage);
  const by = Object.fromEntries(JSON.parse(cli(dir, 'list', '--json').stdout).map((w: Watch) => [w.id, w.notify]));
  assert.deepEqual(by, { plain: false, loud: true, rem: true, rem2: false });
});

test('no notify command means no notification and no error', () => {
  const dir = tempDir();
  const types: TypeRegistry = { t: { check: () => ({}), diff: () => [{ summary: 'act' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  assert.equal(tick(base(dir, types, { notifyRun: () => { throw new Error('must not run'); } })).events.length, 1);
});

test('quiet hours skip ordinary watches and still check notify_overnight ones', () => {
  const dir = tempDir();
  const checked: string[] = [];
  const types: TypeRegistry = { t: { check: (target) => { checked.push(target); return {}; }, diff: () => [] } };
  addWatch(dir, { id: 'day', type: 't', target: 'day' }, NIGHT);
  addWatch(dir, { id: 'night', type: 't', target: 'night', notify_overnight: true }, NIGHT);
  const out = tick(base(dir, types, { config: OPEN, now: NIGHT + MIN }));
  assert.deepEqual(checked, ['night']);
  assert.deepEqual(out.skipped, ['day']);
});

test('quiet hours do not notify for an ordinary watch that expires overnight, but do for notify_overnight', () => {
  const dir = tempDir();
  const sent: (string | undefined)[] = [];
  const notifyRun = (_c: string, a: string[]) => { sent.push(a.at(-1)); return { status: 0 }; };
  addWatch(dir, { id: 'day', type: 't', target: 'x', ttlMs: MIN, notify: true }, NIGHT - 10 * MIN);
  addWatch(dir, { id: 'night', type: 't', target: 'y', ttlMs: MIN, notify_overnight: true, notify: true }, NIGHT - 10 * MIN);
  tick(base(dir, { t: { check: () => ({}), diff: () => [] } }, { config: OPEN, now: NIGHT, notifyCommand: ['n'], notifyRun }));
  assert.equal(sent.length, 1);
  assert.match(String(sent[0]), /^night:/);
});

const LOCAL = (extra: Partial<EventType> = {}): EventType => ({ check: () => ({}), diff: () => [], interval: 60, network: false, ...extra });
const NET = (extra: Partial<EventType> = {}): EventType => ({ check: () => ({}), diff: () => [], interval: 180, network: true, ...extra });
const spy = (type: EventType, log: string[], name: string): EventType => ({ ...type, check: () => { log.push(name); return {}; } });

test('only due watches are checked: each type runs on its own interval', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { fast: spy(LOCAL(), log, 'fast'), slow: spy(NET(), log, 'slow') };
  addWatch(dir, { id: 'f', type: 'fast', target: 'x' }, NOON);
  addWatch(dir, { id: 's', type: 'slow', target: 'x' }, NOON);
  const at = (sec: number) => tick(base(dir, types, { now: NOON + sec * 1000 }));
  at(0);
  assert.deepEqual(log.splice(0), ['fast', 'slow'], 'a new watch is due at once');
  assert.deepEqual(at(30).waiting, ['f', 's']);
  assert.deepEqual(log.splice(0), []);
  assert.deepEqual(at(61).waiting, ['s']);
  assert.deepEqual(log.splice(0), ['fast']);
  at(181);
  assert.deepEqual(log.splice(0), ['fast', 'slow']);
});

test('pace sleeps until the earliest watch is due', () => {
  const dir = tempDir();
  const types: TypeRegistry = { fast: LOCAL(), slow: NET() };
  addWatch(dir, { id: 'f', type: 'fast', target: 'x' }, NOON);
  addWatch(dir, { id: 's', type: 'slow', target: 'x' }, NOON);
  tick(base(dir, types));
  assert.equal(secondsOf(pace({ dir, types, config: ALWAYS, now: NOON })), 60);
  assert.equal(secondsOf(pace({ dir, types, config: ALWAYS, now: NOON + 45 * 1000 })), 15);
  assert.equal(secondsOf(pace({ dir, types, config: ALWAYS, now: NOON + 200 * 1000 })), 1, 'an overdue watch means no wait');
});

test('a watch added before the first tick is due immediately, so pace does not wait for it', () => {
  const dir = tempDir();
  addWatch(dir, { id: 's', type: 'slow', target: 'x' }, NOON);
  assert.equal(secondsOf(pace({ dir, types: { slow: NET() }, config: ALWAYS, now: NOON })), 1);
});

test('a per-watch interval overrides the type default', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { slow: spy(NET(), log, 'slow') };
  addWatch(dir, { id: 's', type: 'slow', target: 'x', interval: 400 }, NOON);
  tick(base(dir, types));
  assert.deepEqual(tick(base(dir, types, { now: NOON + 300 * 1000 })).waiting, ['s']);
  tick(base(dir, types, { now: NOON + 401 * 1000 }));
  assert.equal(log.length, 2);
});

test('a loop-wide pin applies to watches without their own interval, and the floor still holds', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { slow: spy(NET(), log, 'slow') };
  addWatch(dir, { id: 's', type: 'slow', target: 'x' }, NOON);
  const config = { ...ALWAYS, pinned: 10 };
  tick(base(dir, types, { config }));
  tick(base(dir, types, { config, now: NOON + 60 * 1000 }));
  assert.equal(log.length, 1);
  tick(base(dir, types, { config, now: NOON + 121 * 1000 }));
  assert.equal(log.length, 2);
});

test('the network floor holds against --interval, config and a type that declares less', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { greedy: spy(NET({ interval: 5 }), log, 'greedy'), silent: spy({ check: () => ({}), diff: () => [] }, log, 'silent') };
  addWatch(dir, { id: 'a', type: 'greedy', target: 'x' }, NOON);
  addWatch(dir, { id: 'b', type: 'greedy', target: 'x', interval: 1 }, NOON);
  addWatch(dir, { id: 'c', type: 'silent', target: 'x', interval: 1 }, NOON);
  const config = { ...ALWAYS, networkFloor: 10, typeIntervals: { greedy: 2 } };
  tick(base(dir, types, { config }));
  assert.equal(log.splice(0).length, 3);
  assert.equal(tick(base(dir, types, { config, now: NOON + 119 * 1000 })).waiting.length, 3, 'nothing is due under 120s; an undeclared type counts as network');
  tick(base(dir, types, { config, now: NOON + 121 * 1000 }));
  assert.equal(log.length, 3);
});

test('a local type may go down to 30s but no lower, and a raised floor setting is honoured', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { local: spy(LOCAL({ interval: 1 }), log, 'local') };
  addWatch(dir, { id: 'l', type: 'local', target: 'x' }, NOON);
  tick(base(dir, types));
  assert.deepEqual(tick(base(dir, types, { now: NOON + 29 * 1000 })).waiting, ['l']);
  tick(base(dir, types, { now: NOON + 31 * 1000 }));
  assert.equal(log.length, 2);
  const slower = { ...ALWAYS, localFloor: 90 };
  tick(base(dir, types, { config: slower, now: NOON + 100 * 1000 }));
  assert.equal(log.length, 3);
  assert.deepEqual(tick(base(dir, types, { config: slower, now: NOON + 150 * 1000 })).waiting, ['l']);
});

test('a failing check waits for its interval before the retry', () => {
  const dir = tempDir();
  let calls = 0;
  const types: TypeRegistry = { bad: NET({ check: () => { calls += 1; throw new Error('boom'); } }) };
  addWatch(dir, { id: 'w', type: 'bad', target: 'x' }, NOON);
  tick(base(dir, types));
  tick(base(dir, types, { now: NOON + 10 * 1000 }));
  assert.equal(calls, 1);
  tick(base(dir, types, { now: NOON + 181 * 1000 }));
  assert.equal(calls, 2);
});

test('quiet hours still hold: nothing is due-checked overnight except overnight watches', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { t: spy(LOCAL(), log, 't') };
  addWatch(dir, { id: 'day', type: 't', target: 'a' }, NIGHT);
  addWatch(dir, { id: 'night', type: 't', target: 'b', notify_overnight: true }, NIGHT);
  tick(base(dir, types, { config: OPEN, now: NIGHT }));
  assert.equal(log.length, 1);
  assert.equal(secondsOf(pace({ dir, types, config: OPEN, now: NIGHT })), 60);
});

test('quiet hours with no overnight watch stop the loop; no watch at all falls back to the adaptive pace', () => {
  const dir = tempDir();
  assert.equal(stopOf(pace({ dir, config: OPEN, now: NIGHT })), true);
  addWatch(dir, { id: 'day', type: 't', target: 'a' }, NIGHT);
  assert.equal(stopOf(pace({ dir, types: { t: LOCAL() }, config: OPEN, now: NIGHT })), true);
});

test('events feed the back-off: a burst keeps the watch at its pace, a quiet loop stretches it', () => {
  const dir = tempDir();
  const types: TypeRegistry = { t: NET({ diff: () => [{ summary: 'a' }, { summary: 'b' }, { summary: 'c' }] }) };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  tick(base(dir, types));
  assert.equal(secondsOf(pace({ dir, types, config: ALWAYS, now: NOON })), 180);
  const quiet = tempDir();
  const once = { t: NET({ diff: (prev) => (prev ? [] : [{ summary: 'first' }]) }) };
  addWatch(quiet, { id: 'w1', type: 't', target: 'a' }, NOON);
  tick(base(quiet, once, { now: NOON }));
  const later = NOON + 3 * 3600 * 1000;
  tick(base(quiet, once, { now: later }));
  assert.equal(secondsOf(pace({ dir: quiet, types: once, config: ALWAYS, now: later })), 540, '3 hours since the last event stretches 180s by 3x');
});

test('formatDigest lists actionable events first and carries the report hint only on those', () => {
  const text = formatDigest([
    { watch: 'a', type: 't', at: '2026-10-01T12:00:00Z', summary: 'fyi', actionable: false, report: '' },
    { watch: 'b', type: 't', at: '2026-10-01T12:00:00Z', summary: 'go', actionable: true, report: 'name the PR' },
  ]);
  assert.equal(text, 'ACTION b (t): go | report: name the PR\ninfo a (t): fyi');
});

const cli = (dir: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], {
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

test('cli: add --interval is stored on the watch and a non-positive one is refused', () => {
  const dir = tempDir();
  assert.equal(cli(dir, 'add', '--id', 'w1', '--type', 't', '--target', 'x', '--interval', '5').status, 0);
  assert.equal(JSON.parse(cli(dir, 'list', '--json').stdout)[0].interval, 5);
  for (const bad of ['0', 'soon', 'Infinity']) assert.equal(cli(dir, 'add', '--id', 'w2', '--type', 't', '--target', 'x', '--interval', bad).status, EXIT.usage);
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
  const types: TypeRegistry = { t: { check: () => ({}), diff: () => [{ summary: 'act' }] } };
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

test('cli: info-only events survive a quiet run and show in the next actionable digest', () => {
  const dir = tempDir();
  cli(dir, 'add', '--id', 'w1', '--type', 'nope', '--target', 'x');
  appendDigest(dir, [{ watch: 'w0', type: 't', at: 'x', summary: 'merged earlier', actionable: false, report: '' }]);
  assert.match(cli(dir, 'run', '--once').stdout, /no actionable events/);
  assert.match(cli(dir, 'digest', '--peek').stdout, /info w0 \(t\): merged earlier/);
  appendDigest(dir, [{ watch: 'w1', type: 't', at: 'x', summary: 'act', actionable: true, report: '' }]);
  const out = cli(dir, 'digest').stdout;
  assert.match(out, /ACTION w1[\s\S]*info w0/);
});

test('a crash while saving state leaves a finished watch live, so its final event is not lost', () => {
  const dir = tempDir();
  const types: TypeRegistry = { t: { check: () => ({ done: true }), diff: () => [{ summary: 'final' }] } };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  // A directory where state.json goes makes the rename in saveState throw, after the digest append.
  mkdirSync(join(dir, 'state.json'));
  assert.throws(() => tick(base(dir, types)));
  assert.equal(readDigest(dir).length, 1);
  assert.deepEqual(listWatches(dir).map((w) => w.id), ['w1']);
});

test('quiet mode "slow" still counts as quiet: ordinary watches are skipped overnight', () => {
  const dir = tempDir();
  const checked: string[] = [];
  const types: TypeRegistry = { t: { check: (target) => { checked.push(target); return {}; }, diff: () => [] } };
  addWatch(dir, { id: 'day', type: 't', target: 'day' }, NIGHT);
  addWatch(dir, { id: 'night', type: 't', target: 'night', notify_overnight: true }, NIGHT);
  const out = tick(base(dir, types, { config: { ...OPEN, quietMode: 'slow' }, now: NIGHT + MIN }));
  assert.deepEqual(checked, ['night']);
  assert.deepEqual(out.skipped, ['day']);
});

test('pace keeps an overnight watch running through quiet weekends too', () => {
  const dir = tempDir();
  const SATURDAY = Date.parse('2026-10-03T12:00:00Z');
  const config = { quietHours: 'off', quietWeekends: true, tz: 'UTC' };
  addWatch(dir, { id: 'n', type: 't', target: 'y', notify_overnight: true }, SATURDAY);
  assert.equal(stopOf(pace({ dir, config, now: SATURDAY })), undefined);
});

test('lock: a stale lock is replaced by ours, and a live or just-created empty one is refused', () => {
  const dir = tempDir();
  const file = join(dir, 'loop.lock');
  writeFileSync(file, '99999999');
  acquireLock(dir, process.pid);
  assert.equal(readFileSync(file, 'utf8'), String(process.pid));
  writeFileSync(file, '');
  assert.throws(() => acquireLock(dir), /starting/);
  const old = new Date(Date.now() - 60000);
  utimesSync(file, old, old);
  assert.equal(acquireLock(dir), file);
});

test('lock: SIGTERM releases it', async () => {
  const dir = tempDir();
  const lib = new URL('./lib/watch-registry.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from '${lib}'; acquireLock(${JSON.stringify(dir)}); console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  assert.equal(existsSync(join(dir, 'loop.lock')), true);
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  await closed;
  assert.equal(existsSync(join(dir, 'loop.lock')), false);
});

test('a type\'s retired hook runs after a watch retires, and a throwing hook does not break the tick', () => {
  const dir = tempDir();
  const seen: [string, string | undefined][] = [];
  const types: TypeRegistry = {
    t: { check: () => ({ done: true }), diff: () => [], retired: (watch: Watch, ctx: CheckContext) => { seen.push([watch.id, ctx.dir]); } },
    u: { check: () => ({ done: true }), diff: () => [], retired: () => { throw new Error('boom'); } },
  };
  addWatch(dir, { id: 'w1', type: 't', target: 'a' }, NOON);
  addWatch(dir, { id: 'w2', type: 'u', target: 'a' }, NOON);
  assert.equal(tick(base(dir, types)).retired.length, 2);
  assert.deepEqual(seen, [['w1', dir]]);
  assert.equal(listWatches(dir).length, 0);
});

test('cli: run --interval refuses Infinity, zero and text, so a pin cannot defeat the floor', () => {
  for (const bad of ['Infinity', '1e400', '0', 'soon']) assert.equal(cli(tempDir(), 'run', '--once', '--interval', bad).status, EXIT.usage, bad);
});

test('a pin of Infinity that reaches tick anyway still honours the floor', () => {
  const dir = tempDir();
  const log: string[] = [];
  const types: TypeRegistry = { slow: spy(NET(), log, 'slow') };
  addWatch(dir, { id: 's', type: 'slow', target: 'x' }, NOON);
  const config = { ...ALWAYS, pinned: Infinity };
  tick(base(dir, types, { config }));
  assert.equal(Number.isFinite(loadState(dir).watches.s.nextDue), true);
  assert.equal(secondsOf(pace({ dir, types, config, now: NOON })), 180);
});

/** Starts `run` (not --once) over a registry with one unknown-type watch, waits for a heartbeat that says it is asleep, and stops it. */
async function runAndStop(dir: string, ...extra: string[]): Promise<void> {
  const p = spawn(process.execPath, [SCRIPT, 'run', ...extra], { env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir, MAESTRO_WATCH_QUIET_HOURS: 'off' }, stdio: 'ignore' });
  const closed = new Promise((resolve) => p.on('close', resolve));
  const file = join(dir, 'heartbeat.json');
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    try { if (JSON.parse(readFileSync(file, 'utf8')).sleepingUntil) break; } catch { /* not written yet */ }
  }
  p.kill('SIGTERM');
  await closed;
}

test('cli: run writes a heartbeat with its pid, the live watch count and the wake time it sleeps until', async () => {
  const dir = tempDir();
  cli(dir, 'add', '--id', 'w1', '--type', 'nope', '--target', 'x');
  await runAndStop(dir);
  const beat = JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
  assert.equal(beat.mode, 'run');
  assert.equal(beat.watchesLive, 1);
  assert.ok(beat.pid > 0 && beat.tick >= 1);
  assert.ok(Date.parse(beat.sleepingUntil) > Date.parse(beat.at), 'it says when it expects to wake');
  assert.match(beat.lastError, /^$/);
});

test('cli: run --once leaves no heartbeat, so a one-off never reads as a dead loop', () => {
  const dir = tempDir();
  cli(dir, 'add', '--id', 'w1', '--type', 'nope', '--target', 'x');
  assert.equal(cli(dir, 'run', '--once').status, EXIT.ok);
  assert.equal(existsSync(join(dir, 'heartbeat.json')), false);
});

/** Starts `run --serve` over `dir`, polls (up to 10 s) until `ready()` holds, and returns whether the process was still alive at that point; always stops it. */
async function serveUntil(dir: string, ready: () => boolean): Promise<{ alive: boolean; ready: boolean; code: number | null }> {
  const p = spawn(process.execPath, [SCRIPT, 'run', '--serve'], { env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir, MAESTRO_WATCH_QUIET_HOURS: 'off' }, stdio: 'ignore' });
  const closed = new Promise<number | null>((resolve) => p.on('close', resolve));
  let ok = false;
  for (let i = 0; i < 200 && !ok && p.exitCode === null; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    ok = ready();
  }
  await new Promise((r) => setTimeout(r, 300));
  const alive = p.exitCode === null;
  p.kill('SIGTERM');
  return { alive, ready: ok, code: await closed };
}

test('cli: run --serve records an actionable event in the inbox and keeps running; the digest is cleared', async () => {
  const dir = tempDir();
  addWatch(dir, { id: 'rem', type: 'reminder', target: '2026-01-01T00:00:00Z', report: 'free text that stays out' }, Date.now());
  const r = await serveUntil(dir, () => readInbox(dir).length > 0);
  assert.equal(r.ready, true);
  assert.equal(r.alive, true, 'the loop must not exit on an actionable event');
  const [e] = readInbox(dir);
  assert.deepEqual([e.watch, e.type, e.kind, e.actionable, e.seen, e.handled], ['rem', 'reminder', 'reminder', true, false, false]);
  assert.deepEqual(readDigest(dir), []);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('free text'), false);
});

test('cli: run --serve with no watches keeps waiting instead of exiting, and writes a heartbeat', async () => {
  const dir = tempDir();
  const r = await serveUntil(dir, () => existsSync(join(dir, 'heartbeat.json')));
  assert.equal(r.ready, true);
  assert.equal(r.alive, true);
});

test('cli: run --serve cannot be combined with --once', () => {
  const r = cli(tempDir(), 'run', '--once', '--serve');
  assert.equal(r.status, EXIT.usage);
  assert.match(r.stderr, /cannot be combined/);
});

test('draining the digest twice with the same events leaves one inbox entry (a crash replay is a no-op)', () => {
  const dir = tempDir();
  const e = { watch: 'prs', type: 'pr-watch', at: '2026-10-01T12:00:00.000Z', summary: 'THREAD acme/w#1 by someone: https://x.test/t', actionable: true, report: '' };
  appendDigest(dir, [e]);
  drainDigestToInbox(dir);
  appendDigest(dir, [e]);
  drainDigestToInbox(dir);
  assert.equal(readInbox(dir).length, 1);
  assert.deepEqual(readDigest(dir), []);
});

test('drain with no digest file is a no-op, and a claim left by a crash is drained on the next call', () => {
  const dir = tempDir();
  assert.doesNotThrow(() => drainDigestToInbox(dir));
  const e = { watch: 'prs', type: 'pr-watch', at: '2026-10-01T12:00:00.000Z', summary: 'REPLY acme/w#2 by someone: https://x.test/r', actionable: true, report: '' };
  writeFileSync(join(dir, 'digest.jsonl.99999.drain'), `${JSON.stringify(e)}\n`);
  drainDigestToInbox(dir);
  assert.equal(readInbox(dir).length, 1);
  assert.equal(existsSync(join(dir, 'digest.jsonl.99999.drain')), false);
});

test('non-serve run still exits 10 on an actionable event (the contract --serve leaves alone)', () => {
  const dir = tempDir();
  addWatch(dir, { id: 'rem', type: 'reminder', target: '2026-01-01T00:00:00Z', report: 'go' }, Date.now());
  const r = cli(dir, 'run');
  assert.equal(r.status, EXIT.actionable, r.stderr);
  assert.deepEqual(readInbox(dir), []);
});

const SENT = 'SENTINEL-free-text-4c1d';
const digestEvent = (summary: string, actionable = true) => ({ watch: 'prs', type: 'pr-watch', at: '2026-10-01T12:00:00.000Z', summary, actionable, report: '' });

test('cli: events list shows unhandled events by default, --unseen and --all narrow or widen, --json is parseable', () => {
  const dir = tempDir();
  appendEvents(dir, [digestEvent(`THREAD acme/w#1 by someone: ${SENT}`), digestEvent('REPLY acme/w#2 by someone: u')]);
  const [a, b] = readInbox(dir);
  assert.equal(cli(dir, 'events', 'ack', a.id).status, EXIT.ok);
  const shown = (...f: string[]) => cli(dir, 'events', ...f).stdout.trim().split('\n').filter(Boolean);
  assert.equal(shown().length, 1);
  assert.match(shown()[0], new RegExp(`^${b.id} new ACTION reply`));
  assert.equal(shown('list', '--all').length, 2);
  assert.equal(shown('list', '--unseen').length, 1);
  assert.equal(JSON.parse(cli(dir, 'events', '--all', '--json').stdout).length, 2);
  assert.equal(cli(dir, 'events', '--all').stdout.includes(SENT), false);
});

test('cli: events ack marks handled, is idempotent, and refuses an unknown id or none', () => {
  const dir = tempDir();
  appendEvents(dir, [digestEvent('THREAD acme/w#1 by someone: u')]);
  const [e] = readInbox(dir);
  assert.equal(cli(dir, 'events', 'ack', e.id).status, EXIT.ok);
  assert.equal(cli(dir, 'events', 'ack', e.id).status, EXIT.ok);
  assert.equal(readInbox(dir)[0].handled, true);
  const unknown = cli(dir, 'events', 'ack', e.id, 'ffffffffffff');
  assert.equal(unknown.status, EXIT.usage);
  assert.match(unknown.stderr, /no such event: ffffffffffff/);
  assert.equal(cli(dir, 'events', 'ack').status, EXIT.usage);
  assert.equal(cli(dir, 'events', 'bogus').status, EXIT.usage);
});

test('cli: events wait prints an unseen actionable event, marks it seen and exits 10; then it times out quietly', () => {
  const dir = tempDir();
  appendEvents(dir, [digestEvent('THREAD acme/w#1 by someone: u'), digestEvent('info only', false)]);
  const first = cli(dir, 'events', 'wait', '--poll-seconds', '0.1');
  assert.equal(first.status, EXIT.actionable, first.stderr);
  assert.equal(first.stdout.trim().split('\n').length, 1);
  assert.deepEqual(readInbox(dir).map((e) => e.seen), [true, false]);
  const second = cli(dir, 'events', 'wait', '--timeout-hours', '0.00003', '--poll-seconds', '0.05');
  assert.equal(second.status, EXIT.ok);
  assert.equal(second.stdout, '');
});

test('cli: events wait wakes on an event appended while it waits', async () => {
  const dir = tempDir();
  const p = spawn(process.execPath, [SCRIPT, 'events', 'wait', '--poll-seconds', '0.1'], { env: { ...process.env, MAESTRO_LOCAL_CONFIG: '', MAESTRO_EVENT_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const closed = new Promise<number | null>((resolve) => p.on('close', resolve));
  await new Promise((r) => setTimeout(r, 400));
  appendEvents(dir, [digestEvent('CONFLICT acme/w#9 main <- f https://x.test')]);
  assert.equal(await closed, EXIT.actionable);
  assert.match(out, /conflict prs \(pr-watch\) repo=acme\/w number=9/);
});

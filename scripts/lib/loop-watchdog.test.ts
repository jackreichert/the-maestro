// Run: node --test scripts/lib/loop-watchdog.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdog, HANG_GRACE_MS, hangDeadline } from './loop-watchdog.ts';
import type { Heartbeat } from './heartbeat.ts';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({ pid: 42, at: iso(T0), tick: 1, watchesLive: 1, sleepingUntil: null, mode: 'run', lastError: '', ...over });

test('the deadline is the later of the last write and the declared wake time, plus the grace', () => {
  assert.equal(hangDeadline({ heartbeat: beat({ at: iso(T0), sleepingUntil: iso(T0 + 30 * 60_000) }), childPid: 42, launchedAt: T0 }), T0 + 30 * 60_000 + HANG_GRACE_MS);
  assert.equal(hangDeadline({ heartbeat: beat({ at: iso(T0) }), childPid: 42, launchedAt: T0 - 1000 }), T0 + HANG_GRACE_MS);
});

test('a heartbeat from another pid, or from the supervisor, does not count; the launch time does', () => {
  assert.equal(hangDeadline({ heartbeat: beat({ pid: 7 }), childPid: 42, launchedAt: T0 + 5 }), T0 + 5 + HANG_GRACE_MS);
  assert.equal(hangDeadline({ heartbeat: beat({ mode: 'idle' }), childPid: 42, launchedAt: T0 + 5 }), T0 + 5 + HANG_GRACE_MS);
  assert.equal(hangDeadline({ heartbeat: null, childPid: 42, launchedAt: T0 + 5 }), T0 + 5 + HANG_GRACE_MS);
});

function rig(hb: () => Heartbeat | null) {
  const clock = { now: T0 };
  const logs: string[] = [];
  const kills: string[] = [];
  const dog = createWatchdog({ childPid: 42, launchedAt: T0, readBeat: hb, now: () => clock.now, log: (l) => logs.push(l), kill: (sig) => { kills.push(sig); } });
  return { clock, logs, kills, dog };
}

test('a fresh heartbeat is never killed, however many checks pass', () => {
  const r = rig(() => beat({ at: iso(r.clock.now) }));
  for (let i = 0; i < 50; i += 1) { r.clock.now += 60_000; assert.equal(r.dog.check(), false); }
  assert.deepEqual(r.kills, []);
});

test('a stale heartbeat is killed on the second consecutive check, with SIGTERM first and a log line', () => {
  const r = rig(() => beat({ at: iso(T0) }));
  r.clock.now = T0 + HANG_GRACE_MS + 1000;
  assert.equal(r.dog.check(), false);
  assert.deepEqual(r.kills, []);
  r.clock.now += 60_000;
  assert.equal(r.dog.check(), true);
  assert.deepEqual(r.kills, ['SIGTERM']);
  assert.match(r.logs.join('\n'), /hung/);
  assert.match(r.logs.join('\n'), /pid 42/);
});

test('one stale look followed by a fresh heartbeat (a machine waking from sleep) is forgiven', () => {
  let stale = true;
  const r = rig(() => beat({ at: iso(stale ? T0 : r.clock.now) }));
  r.clock.now = T0 + 3 * 3600_000;
  assert.equal(r.dog.check(), false);
  stale = false;
  r.clock.now += 60_000;
  assert.equal(r.dog.check(), false);
  r.clock.now += 60_000;
  assert.equal(r.dog.check(), false);
  assert.deepEqual(r.kills, []);
});

test('a child that does not end after SIGTERM gets SIGKILL on a later check', () => {
  const r = rig(() => beat({ at: iso(T0) }));
  r.clock.now = T0 + HANG_GRACE_MS + 1000;
  r.dog.check();
  r.clock.now += 60_000;
  r.dog.check();
  r.clock.now += 5_000;
  r.dog.check();
  assert.deepEqual(r.kills, ['SIGTERM']);
  r.clock.now += 20_000;
  r.dog.check();
  assert.deepEqual(r.kills, ['SIGTERM', 'SIGKILL']);
  r.clock.now += 20_000;
  r.dog.check();
  assert.deepEqual(r.kills, ['SIGTERM', 'SIGKILL']);
});

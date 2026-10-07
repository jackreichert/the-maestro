// Run: node --test scripts/lib/loop-health.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopHealth, STALL_GRACE_MS } from './loop-health.ts';
import type { HealthInput } from './loop-health.ts';
import type { Heartbeat } from './heartbeat.ts';

const NOW = Date.parse('2026-10-07T18:00:00Z');
const MIN = 60_000;
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({ pid: 10, at: new Date(NOW - 2 * MIN).toISOString(), tick: 1, watchesLive: 2, sleepingUntil: new Date(NOW - MIN).toISOString(), mode: 'run', lastError: '', ...over });
const input = (over: Partial<HealthInput> = {}): HealthInput => ({ now: NOW, heartbeat: beat(), lockPid: 10, supervisor: { state: 'running' }, required: false, alive: () => true, tz: 'America/New_York', ...over });

test('a fresh heartbeat from a live writer is ok, with its age', () => {
  const h = loopHealth(input());
  assert.equal(h.state, 'ok');
  assert.equal(h.line, '**Loop:** ok 2 min');
});

test('a heartbeat past its own planned wake time plus the grace is STALLED, whatever the lock says', () => {
  const at = NOW - 20 * MIN;
  const h = loopHealth(input({ heartbeat: beat({ at: new Date(at).toISOString(), sleepingUntil: new Date(at + MIN).toISOString() }) }));
  assert.equal(h.state, 'stalled');
  assert.match(h.line, /^\*\*Loop:\*\* STALLED 20 min/);
});

test('a long planned sleep is not stalled until the wake time plus the grace has passed', () => {
  const wake = NOW + 10 * MIN;
  assert.equal(loopHealth(input({ heartbeat: beat({ at: new Date(NOW - 30 * MIN).toISOString(), sleepingUntil: new Date(wake).toISOString() }) })).state, 'ok');
  const late = loopHealth(input({ now: wake + STALL_GRACE_MS + 1, heartbeat: beat({ at: new Date(NOW - 30 * MIN).toISOString(), sleepingUntil: new Date(wake).toISOString() }) }));
  assert.equal(late.state, 'stalled');
});

test('quiet hours written by the supervisor read as quiet, with the wake time in the zone', () => {
  const h = loopHealth(input({ heartbeat: beat({ mode: 'quiet', sleepingUntil: '2026-10-08T11:00:00Z' }), now: Date.parse('2026-10-08T03:00:00Z') }));
  assert.equal(h.state, 'quiet');
  assert.equal(h.line, '**Loop:** quiet until 07:00 EDT');
});

test('a dead heartbeat writer with a supervisor set up is DOWN since its last beat', () => {
  const h = loopHealth(input({ alive: () => false, lockPid: null }));
  assert.equal(h.state, 'down');
  assert.match(h.line, /^\*\*Loop:\*\* DOWN since 13:58 EDT$/);
});

test('a supervisor set up with no heartbeat ever is DOWN; with nothing set up it is silent, or NOT INSTALLED when required', () => {
  assert.equal(loopHealth(input({ heartbeat: null, lockPid: null })).line, '**Loop:** DOWN');
  assert.deepEqual(loopHealth(input({ heartbeat: null, lockPid: null, supervisor: { state: 'absent' } })), { state: 'absent', line: '' });
  const req = loopHealth(input({ heartbeat: null, lockPid: null, supervisor: { state: 'absent' }, required: true }));
  assert.equal(req.state, 'not-installed');
  assert.match(req.line, /NOT INSTALLED/);
});

test('a loop holding the lock that never wrote a heartbeat reads as running, not down', () => {
  assert.equal(loopHealth(input({ heartbeat: null, lockPid: 77, supervisor: { state: 'absent' } })).state, 'running');
});

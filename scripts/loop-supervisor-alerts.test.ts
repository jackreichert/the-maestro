import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise, waitWithAlerts } from './loop-supervisor.ts';
import { readHeartbeat, writeHeartbeat } from './lib/heartbeat.ts';
import type { HeartbeatMode } from './lib/heartbeat.ts';
import { loopHealth } from './lib/loop-health.ts';
import { DEFAULT_ALERT_QUIET_HOURS, HEALTH_AFTER_MS, runAlerts } from './lib/alert-policy.ts';

const SUPERVISOR = 4242;
const DEAD_CHILD = 999_999;
const CFG = { quietHours: DEFAULT_ALERT_QUIET_HOURS, tz: 'UTC' };
const NOON = Date.parse('2026-10-09T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** A supervisor with a simulated clock: each launch of the loop beats as the child (`run`), then dies; the wait is the real `waitWithAlerts`. */
function simulate(opts: { launches: number; code: number; supervisorBeats?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-sim-'));
  let clock = NOON;
  const texts: string[] = [];
  const logs: string[] = [];
  const beat = (mode: HeartbeatMode, until: number, lastError: string): void => {
    if (opts.supervisorBeats !== false) writeHeartbeat(dir, { pid: SUPERVISOR, at: iso(clock), tick: 0, watchesLive: 0, sleepingUntil: iso(until), mode, lastError });
  };
  // The inputs production gives liveLoopHealth: the newest heartbeat on disk, a free lock, a live supervisor record.
  const health = () => loopHealth({ now: clock, heartbeat: readHeartbeat(dir), lockPid: null, supervisor: { state: 'running', pid: SUPERVISOR }, required: false, alive: (pid) => pid === SUPERVISOR, tz: 'UTC' });
  const alertTick = (): void => { const t = runAlerts({ eventDir: dir, command: ['notify'], now: clock, entries: [], health: health(), config: CFG, run: (_c, a) => { texts.push(a.join(' ')); return { status: 0 }; } }); void t; };
  const sleep = waitWithAlerts({ beat, alertTick, log: (l) => { logs.push(l); }, now: () => clock, nap: async (s) => { clock += s * 1000; } });
  const runLoop = async () => {
    writeHeartbeat(dir, { pid: DEAD_CHILD, at: iso(clock), tick: 1, watchesLive: 1, sleepingUntil: iso(clock), mode: 'run', lastError: '' });
    clock += 1000;
    return { code: opts.code, stdout: '', stderr: '' };
  };
  return { dir, texts, logs, run: () => supervise({ runLoop, sleep, save: () => {}, log: (l) => { logs.push(l); }, now: () => clock, maxRuns: opts.launches }), clock: () => clock };
}

test('a healthy supervisor between launches sends "loop started" once and never "loop DOWN"', async () => {
  // 12 launches of an idle loop, 300 s apart: 1 hour of simulated time, far past the 15 minute DOWN threshold.
  const sim = simulate({ launches: 12, code: 0 });
  try {
    await sim.run();
    assert.ok(sim.clock() - NOON > 4 * HEALTH_AFTER_MS);
    assert.deepEqual(sim.texts, ['maestro: loop started']);
    assert.deepEqual(sim.logs, []);
  } finally { rmSync(sim.dir, { recursive: true, force: true }); }
});

test('the alert tick runs after the supervisor wrote its own heartbeat, never against the dead child\'s', async () => {
  const sim = simulate({ launches: 1, code: 0 });
  const seen: string[] = [];
  let t = NOON;
  try {
    const sleep = waitWithAlerts({ beat: (mode, until, lastError) => { writeHeartbeat(sim.dir, { pid: SUPERVISOR, at: iso(NOON), tick: 0, watchesLive: 0, sleepingUntil: iso(until), mode, lastError }); seen.push('beat'); }, alertTick: () => { seen.push(`tick:${readHeartbeat(sim.dir)?.pid}`); }, log: () => {}, now: () => t, nap: async (s) => { t += s * 1000; } });
    await sleep(60);
    assert.deepEqual(seen, ['beat', `tick:${SUPERVISOR}`]);
  } finally { rmSync(sim.dir, { recursive: true, force: true }); }
});

test('a supervisor that stops beating after a healthy stretch is still texted as DOWN once 15 minutes have passed', async () => {
  const healthy = simulate({ launches: 3, code: 0 });
  try {
    await healthy.run();
    assert.deepEqual(healthy.texts, ['maestro: loop started']);
    // Same state directory, the child's dead `run` beat is now the newest and the supervisor no longer beats: that is a real outage.
    const dir = healthy.dir;
    let now = healthy.clock() + 25 * 60_000;
    writeHeartbeat(dir, { pid: DEAD_CHILD, at: iso(now - 20 * 60_000), tick: 1, watchesLive: 1, sleepingUntil: iso(now - 20 * 60_000), mode: 'run', lastError: '' });
    const down = () => loopHealth({ now, heartbeat: readHeartbeat(dir), lockPid: null, supervisor: { state: 'running', pid: SUPERVISOR }, required: false, alive: (pid) => pid === SUPERVISOR, tz: 'UTC' });
    const sent: string[] = [];
    for (let i = 0; i < 4; i += 1, now += 6 * 60_000) runAlerts({ eventDir: dir, command: ['notify'], now, entries: [], health: down(), config: CFG, run: (_c, a) => { sent.push(a.join(' ')); return { status: 0 }; } });
    assert.deepEqual(sent, ['maestro: loop DOWN']);
  } finally { rmSync(healthy.dir, { recursive: true, force: true }); }
});

test('a throwing alert tick is logged and does not stop the wait', async () => {
  const logs: string[] = [];
  let naps = 0;
  const sleep = waitWithAlerts({ beat: () => {}, alertTick: () => { throw new Error('nope'); }, log: (l) => { logs.push(l); }, nap: async () => { naps += 1; }, now: (() => { let t = 0; return () => (t += 30_000); })() });
  await sleep(100);
  assert.ok(naps >= 1);
  assert.match(logs[0] ?? '', /^alert tick failed: nope/);
});

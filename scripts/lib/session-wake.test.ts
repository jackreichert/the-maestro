import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxEntry } from './event-inbox.ts';
import { registerWaiter } from './waiters.ts';
import { GRACE_MS, MAX_PER_DAY, MIN_GAP_MS, WAKE_NOTIFY_LINE, WAKE_PROMPT, decideWake, emptyWakeState, readWakeState, runWakeTick, wakeLogPath } from './session-wake.ts';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  id: 'abc', watch: 'w', type: 'reminder', kind: 'reminder', at: new Date(NOW - GRACE_MS - 1000).toISOString(),
  actionable: true, fields: {}, seen: false, handled: false, seenWindows: [], ...over,
});
const base = { now: NOW, entries: [entry()], waiterLive: false, sessionActive: false, state: emptyWakeState(), hasLaunchCommand: true, hasNotifyCommand: false };

test('an old unseen actionable event with nobody listening launches', () => {
  assert.deepEqual(decideWake(base), { action: 'launch', reason: 'launched' });
});

test('each guard stops a launch for its own reason', () => {
  assert.equal(decideWake({ ...base, entries: [] }).reason, 'nothing-waiting');
  assert.equal(decideWake({ ...base, entries: [entry({ seen: true })] }).reason, 'nothing-waiting');
  assert.equal(decideWake({ ...base, entries: [entry({ handled: true })] }).reason, 'nothing-waiting');
  assert.equal(decideWake({ ...base, entries: [entry({ actionable: false })] }).reason, 'nothing-waiting');
  assert.equal(decideWake({ ...base, entries: [entry({ at: new Date(NOW - 1000).toISOString() })] }).reason, 'within-grace');
  assert.equal(decideWake({ ...base, waiterLive: true }).reason, 'waiter-live');
  assert.equal(decideWake({ ...base, sessionActive: true }).reason, 'session-active');
  assert.equal(decideWake({ ...base, hasLaunchCommand: false }).reason, 'no-command');
});

test('launches are spaced MIN_GAP_MS apart and capped per day', () => {
  const recent = { ...emptyWakeState(), launches: [NOW - MIN_GAP_MS + 1000] };
  assert.equal(decideWake({ ...base, state: recent }).reason, 'rate-limited');
  const spaced = { ...emptyWakeState(), launches: [NOW - MIN_GAP_MS] };
  assert.equal(decideWake({ ...base, state: spaced }).action, 'launch');
  const full = { ...emptyWakeState(), launches: Array.from({ length: MAX_PER_DAY }, (_, i) => NOW - (i + 1) * MIN_GAP_MS) };
  assert.equal(decideWake({ ...base, state: full }).reason, 'rate-limited');
  const yesterday = { ...emptyWakeState(), launches: Array.from({ length: MAX_PER_DAY }, (_, i) => NOW - 25 * 3_600_000 - i) };
  assert.equal(decideWake({ ...base, state: yesterday }).action, 'launch');
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 'wake-'));

test('a tick runs the launch command with the fixed prompt as its last argument and logs it', () => {
  const dir = tmp();
  try {
    const calls: [string, string[]][] = [];
    const d = runWakeTick({ eventDir: dir, now: NOW, entries: [entry()], launchCommand: ['open-it', '--flag'], notifyCommand: [], transcriptsDir: '', run: (c, a) => { calls.push([c, a]); return { status: 0 }; } });
    assert.equal(d.action, 'launch');
    assert.deepEqual(calls, [['open-it', ['--flag', WAKE_PROMPT]]]);
    assert.deepEqual(readWakeState(dir).launches, [NOW]);
    const rows = readFileSync(wakeLogPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows, [{ at: new Date(NOW).toISOString(), action: 'launch', reason: 'launched', ok: true }]);
    assert.equal(runWakeTick({ eventDir: dir, now: NOW + 60_000, entries: [entry()], launchCommand: ['open-it'], notifyCommand: [], transcriptsDir: '', run: () => { throw new Error('must not run'); } }).reason, 'rate-limited');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('event text, the watch name and the event id never reach the launch argv or the log', () => {
  const dir = tmp();
  try {
    const hostile = entry({ watch: 'SENTINEL-watch', id: 'SENTINEL-id', fields: { repo: 'SENTINEL/repo', number: 7 } });
    const calls: string[][] = [];
    runWakeTick({ eventDir: dir, now: NOW, entries: [hostile], launchCommand: ['x'], notifyCommand: [], transcriptsDir: '', run: (c, a) => { calls.push([c, ...a]); return { status: 0 }; } });
    assert.doesNotMatch(JSON.stringify(calls), /SENTINEL/);
    assert.doesNotMatch(readFileSync(wakeLogPath(dir), 'utf8'), /SENTINEL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed launch still counts against the rate limit, and the tick does not throw', () => {
  const dir = tmp();
  try {
    runWakeTick({ eventDir: dir, now: NOW, entries: [entry()], launchCommand: ['x'], notifyCommand: [], transcriptsDir: '', run: () => ({ status: 1 }) });
    assert.deepEqual(readWakeState(dir).launches, [NOW]);
    assert.equal(JSON.parse(readFileSync(wakeLogPath(dir), 'utf8')).ok, false);
    const threw = runWakeTick({ eventDir: dir, now: NOW + MIN_GAP_MS, entries: [entry()], launchCommand: ['x'], notifyCommand: [], transcriptsDir: '', run: () => { throw new Error('boom'); } });
    assert.equal(threw.action, 'none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live waiter, or a fresh interactive transcript, blocks the tick; a headless one does not', () => {
  const dir = tmp();
  const projects = join(dir, 'projects');
  try {
    mkdirSync(projects);
    const deps = { eventDir: dir, now: Date.now(), entries: [entry({ at: new Date(Date.now() - GRACE_MS - 1000).toISOString() })], launchCommand: ['x'], notifyCommand: [], transcriptsDir: projects, run: () => ({ status: 0 }) };
    writeFileSync(join(projects, 'headless.jsonl'), `${JSON.stringify({ type: 'user', entrypoint: 'sdk-cli', timestamp: 't' })}\n`);
    const off = registerWaiter(dir, 'w1');
    assert.equal(runWakeTick(deps).reason, 'waiter-live');
    off();
    writeFileSync(join(projects, 'cli.jsonl'), `${JSON.stringify({ type: 'user', entrypoint: 'cli', timestamp: 't' })}\n`);
    assert.equal(runWakeTick(deps).reason, 'session-active');
    rmSync(join(projects, 'cli.jsonl'));
    assert.equal(runWakeTick(deps).action, 'launch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with no launch command the tick does nothing and never texts', () => {
  const dir = tmp();
  try {
    const d = runWakeTick({ eventDir: dir, now: NOW, entries: [entry()], launchCommand: [], notifyCommand: [], transcriptsDir: '', run: () => { throw new Error('must not run'); } });
    assert.deepEqual(d, { action: 'none', reason: 'no-command' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a history file that cannot be written blocks the launch, so the cap cannot be bypassed', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'wake-launch.json'));
    let launches = 0;
    for (let i = 0; i < 5; i += 1) {
      runWakeTick({ eventDir: dir, now: NOW + i * 60_000, entries: [entry()], launchCommand: ['x'], notifyCommand: [], transcriptsDir: '', run: () => { launches += 1; return { status: 0 }; } });
    }
    assert.equal(launches, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with only a notify command, an event the alerts will not text gets one fixed line, rate limited', () => {
  const dir = tmp();
  try {
    const sent: string[][] = [];
    const wake = entry({ type: 'wake', kind: 'other', fields: { repo: 'SENTINEL/repo' } });
    const deps = { eventDir: dir, now: NOW, entries: [wake], launchCommand: [], notifyCommand: ['say'], transcriptsDir: '', run: (c: string, a: string[]) => { sent.push([c, ...a]); return { status: 0 }; } };
    assert.equal(runWakeTick(deps).action, 'notify');
    assert.equal(runWakeTick({ ...deps, now: NOW + 1000 }).reason, 'rate-limited');
    assert.deepEqual(sent, [['say', WAKE_NOTIFY_LINE]]);
    assert.doesNotMatch(JSON.stringify(sent), /SENTINEL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with only a notify command, an event the alerts already text gets no second text from the launcher', () => {
  const dir = tmp();
  try {
    const d = runWakeTick({ eventDir: dir, now: NOW, entries: [entry({ kind: 'reminder' }), entry({ id: 'b', type: 'wake', kind: 'other' })], launchCommand: [], notifyCommand: ['say'], transcriptsDir: '', run: () => { throw new Error('must not run'); } });
    assert.equal(d.action, 'none');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with no command at all the tick does not look at waiters or transcripts', () => {
  const dir = tmp();
  try {
    const off = registerWaiter(dir, 'w1');
    let probed = 0;
    const d = runWakeTick({ eventDir: dir, now: NOW, entries: [entry()], launchCommand: [], notifyCommand: [], transcriptsDir: '', alive: () => { probed += 1; return true; } });
    off();
    assert.deepEqual(d, { action: 'none', reason: 'no-command' });
    assert.equal(probed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a wake event that stays unseen gets at most MAX_PER_DAY fallback texts in 24 hours', () => {
  const dir = tmp();
  try {
    let sent = 0;
    const wake = entry({ type: 'wake', kind: 'other' });
    for (let t = 0; t < 24 * 3_600_000; t += 60_000) {
      runWakeTick({ eventDir: dir, now: NOW + t, entries: [wake], launchCommand: [], notifyCommand: ['say'], transcriptsDir: '', run: () => { sent += 1; return { status: 0 }; } });
    }
    assert.equal(sent, MAX_PER_DAY);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

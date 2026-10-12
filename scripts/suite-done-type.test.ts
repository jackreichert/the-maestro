// Run: node --test scripts/suite-done-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pace, tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as suiteDone from './event-types/suite-done.ts';
import { addWatch, listWatches, readDigest } from './lib/watch-registry.ts';
import type { Results } from './suite-run.ts';

const RESULTS: Results = {
  job: 'job-1', worktree: '/w', head: 'abcdef1234567890', dirty: false, startedAt: '2026-10-12T01:00:00Z', endedAt: '2026-10-12T01:04:00Z', pass: false,
  tsc: { exit: 0 }, typecheck: 'tsc --noEmit', tests: { exit: 1, pass: 9, fail: 1, cancelled: 0, failing: ['the broken one'] }, concurrency: 2, timedOut: false,
};

/** A suites dir with job `id`: a spec naming a dead worker, plus results when given. */
function job(base: string, id: string, results?: Results): void {
  mkdirSync(join(base, id), { recursive: true });
  writeFileSync(join(base, id, 'job.json'), JSON.stringify({ id, worktree: '/w', head: 'abcdef1234567890', workerPid: process.pid }));
  if (results) writeFileSync(join(base, id, 'results.json'), JSON.stringify(results));
}

test('suite-done: running is silent, results.json appearing is one actionable event, then done', () => {
  const base = mkdtempSync(join(tmpdir(), 'suites-'));
  job(base, 'job-1');
  const running = suiteDone.check('job-1', undefined, base);
  assert.equal(running.state, 'running');
  assert.deepEqual(suiteDone.diff(null, running), []);
  assert.equal(suiteDone.done(running), false);
  job(base, 'job-1', RESULTS);
  const finished = suiteDone.check('job-1', undefined, base);
  assert.equal(finished.state, 'done');
  const [event, ...rest] = suiteDone.diff(running, finished);
  assert.equal(rest.length, 0);
  assert.equal(event?.actionable, true);
  assert.match(event?.summary ?? '', /FAIL at abcdef123456.*1 fail.*failing: the broken one.*fresh reviewer/);
  assert.equal(suiteDone.done(finished), true);
  assert.equal(suiteDone.diff(null, finished).length, 1, 'a job already finished at the first check still wakes');
});

test('suite-done: a worker that died without results is reported as lost', () => {
  const base = mkdtempSync(join(tmpdir(), 'suites-'));
  mkdirSync(join(base, 'dead-1'));
  writeFileSync(join(base, 'dead-1', 'job.json'), JSON.stringify({ id: 'dead-1', workerPid: 0 }));
  const state = suiteDone.check('dead-1', undefined, base);
  assert.equal(state.state, 'lost');
  assert.match(suiteDone.diff(null, state)[0]?.summary ?? '', /lost/);
  assert.equal(suiteDone.done(state), true);
});

test('suite-done: add refuses an unknown job id and a path-shaped one', () => {
  const base = mkdtempSync(join(tmpdir(), 'suites-'));
  const saved = process.env.MAESTRO_SUITE_DIR;
  process.env.MAESTRO_SUITE_DIR = base;
  try {
    assert.throws(() => suiteDone.validate('nope'), /existing job id/);
    assert.throws(() => suiteDone.validate('../etc'), /not a job id/);
    job(base, 'job-1');
    suiteDone.validate('job-1');
  } finally { if (saved === undefined) delete process.env.MAESTRO_SUITE_DIR; else process.env.MAESTRO_SUITE_DIR = saved; }
});

test('suite-done through the loop: the digest gets one actionable line when results appear, and the watch retires', () => {
  const base = mkdtempSync(join(tmpdir(), 'suites-'));
  const dir = mkdtempSync(join(tmpdir(), 'loop-'));
  const saved = process.env.MAESTRO_SUITE_DIR;
  process.env.MAESTRO_SUITE_DIR = base;
  try {
    const NOON = Date.parse('2026-10-12T12:00:00Z');
    job(base, 'job-1');
    addWatch(dir, { id: 'suite-job-1', type: 'suite-done', target: 'job-1' }, NOON);
    const deps = (now: number) => ({ dir, types: BUILTIN_TYPES, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config: { quietHours: 'off' }, now });
    assert.deepEqual(tick(deps(NOON)).events, []);
    job(base, 'job-1', { ...RESULTS, pass: true, tests: { exit: 0, pass: 10, fail: 0, cancelled: 0, failing: [] } });
    const { events, retired } = tick(deps(NOON + 60_000));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.watch, 'suite-job-1');
    assert.equal(events[0]?.actionable, true);
    assert.match(events[0]?.summary ?? '', /PASS at abcdef123456/);
    assert.deepEqual(retired.map((r) => r.id), ['suite-job-1']);
    assert.equal(listWatches(dir).length, 0);
    assert.equal(readDigest(dir).length, 1);
  } finally { if (saved === undefined) delete process.env.MAESTRO_SUITE_DIR; else process.env.MAESTRO_SUITE_DIR = saved; }
});

test('suite-done runs in quiet hours: results landing overnight are reported, and the 24h TTL outlasts the quiet window', () => {
  const base = mkdtempSync(join(tmpdir(), 'suites-'));
  const dir = mkdtempSync(join(tmpdir(), 'loop-'));
  const saved = process.env.MAESTRO_SUITE_DIR;
  process.env.MAESTRO_SUITE_DIR = base;
  try {
    const START = Date.parse('2026-10-12T22:30:00Z');
    const quiet = { quietHours: '23:00-07:00', quietMode: 'stop', tz: 'UTC' };
    const deps = (now: number) => ({ dir, types: BUILTIN_TYPES, ctx: { run: () => ({ status: 0, stdout: '', stderr: '' }) }, config: quiet, now });
    job(base, 'job-q');
    const ttl = suiteDone.defaultTtlMs();
    assert.ok(ttl >= 24 * 3600 * 1000);
    const w = addWatch(dir, { id: 'suite-job-q', type: 'suite-done', target: 'job-q', ttlMs: ttl }, START);
    assert.equal(Date.parse(w.expires) - START, ttl);
    tick(deps(START));
    const MIDNIGHT = Date.parse('2026-10-13T01:00:00Z');
    assert.equal('stop' in pace({ dir, types: BUILTIN_TYPES, config: quiet, now: MIDNIGHT }), false, 'the loop does not stop for quiet hours while a suite watch is live');
    job(base, 'job-q', { ...RESULTS, pass: true, tests: { exit: 0, pass: 10, fail: 0, cancelled: 0, failing: [] } });
    const out = tick(deps(MIDNIGHT));
    assert.deepEqual(out.skipped, []);
    assert.equal(out.events.length, 1);
    assert.match(out.events[0]?.summary ?? '', /PASS/);
    assert.deepEqual(out.retired.map((r) => r.id), ['suite-job-q']);
  } finally { if (saved === undefined) delete process.env.MAESTRO_SUITE_DIR; else process.env.MAESTRO_SUITE_DIR = saved; }
});

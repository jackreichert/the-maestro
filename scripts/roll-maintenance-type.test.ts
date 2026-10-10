// Run: node --test scripts/roll-maintenance-type.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import { BUILTIN_TYPES } from './event-types/index.ts';
import * as maint from './event-types/roll-maintenance.ts';
import { maintainLine } from './lib/journal/maintain.ts';
import { addWatch, listWatches } from './lib/watch-registry.ts';
import type { MaintenanceIo, RollMaintenanceState } from './event-types/roll-maintenance.ts';
import type { MaintainResult } from './lib/journal/maintain.ts';
import type { Run } from './lib/types.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-09T13:00:00Z');
const OK: MaintainResult = { ok: true, archivedDays: ['2026-10-08'], sweep: { removed: 1, pruned: 0, kept: 2, skipped: 0, failed: 0 }, problems: [] };
const noRun: Run = () => ({ status: 0, stdout: '', stderr: '' });

/** A fake world: the local day is the UTC day plus an offset, and maintain answers from a script. */
function rig(answers: (MaintainResult | Error)[]) {
  const calls: { today: string }[] = [];
  let state: RollMaintenanceState | null = null;
  let offsetH = 0;
  const io: MaintenanceIo = {
    localDay: (now) => new Date(now + offsetH * HOUR).toISOString().slice(0, 10),
    maintain: (_t, today) => { calls.push({ today }); const a = answers.shift() ?? OK; if (a instanceof Error) throw a; return a; },
  };
  return {
    calls,
    setOffset: (h: number) => { offsetH = h; },
    /** One check at `now`; returns the events its diff reports against the previous state. */
    at: (now: number) => { const prev = state; state = maint.check('box', { now, prev, run: noRun }, io); return { state, events: maint.diff(prev, state) }; },
  };
}

test('the first check of a day runs maintain, silently; later checks that day do nothing', () => {
  const r = rig([OK]);
  const first = r.at(T0);
  assert.deepEqual(first.events, []);
  assert.equal(first.state.ranDay, '2026-10-09');
  assert.equal(first.state.last, 'archived 1 day(s), swept 1 removed, 0 pruned, 2 kept');
  for (let i = 1; i <= 20; i++) r.at(T0 + i * 15 * 60_000);
  assert.equal(r.calls.length, 1);
});

test('a day change runs it again, once, with the new day', () => {
  const r = rig([OK, OK]);
  r.at(T0);
  r.at(T0 + 10 * HOUR);
  assert.deepEqual(r.calls.map((c) => c.today), ['2026-10-09'], '23:00 is still the same day');
  r.at(T0 + 12 * HOUR);
  r.at(T0 + 13 * HOUR);
  assert.deepEqual(r.calls.map((c) => c.today), ['2026-10-09', '2026-10-10']);
});

test('the day is the local one: the same UTC instant is a new day in a zone ahead', () => {
  const r = rig([OK, OK]);
  r.at(T0);
  r.setOffset(11);
  r.at(T0 + 15 * 60_000);
  assert.deepEqual(r.calls.map((c) => c.today), ['2026-10-09', '2026-10-10']);
});

test('a failed run raises one actionable alert, is retried after an hour, and stays quiet while the message repeats', () => {
  const r = rig([{ ...OK, ok: false, problems: ['worktree sweep: proj: git fetch failed'] }, { ...OK, ok: false, problems: ['worktree sweep: proj: git fetch failed'] }, OK]);
  const bad = r.at(T0);
  assert.deepEqual(bad.events, [{ summary: 'roll maintenance failed: worktree sweep: proj: git fetch failed', actionable: true }]);
  assert.equal(bad.state.ranDay, '', 'the day is not marked done');
  r.at(T0 + 30 * 60_000);
  assert.equal(r.calls.length, 1, 'no retry inside the hour');
  assert.deepEqual(r.at(T0 + HOUR).events, [], 'the same message is not raised again');
  assert.equal(r.calls.length, 2);
  const good = r.at(T0 + 2 * HOUR);
  assert.deepEqual([r.calls.length, good.state.ranDay, good.state.error, good.events], [3, '2026-10-09', '', []]);
});

test('a new failure message after recovery is raised again', () => {
  const r = rig([new Error('boom'), OK, new Error('boom')]);
  assert.equal(r.at(T0).events.length, 1);
  r.at(T0 + HOUR);
  r.at(T0 + 25 * HOUR);
  assert.equal(r.calls.length, 3);
});

test('a throw (crash, timeout, no result line) is an alert, not a thrown check', () => {
  const r = rig([new Error('maintain printed no result (exit 1: boom)')]);
  const bad = r.at(T0);
  assert.match(bad.events[0]?.summary ?? '', /^roll maintenance failed: maintain printed no result/);
  assert.equal(bad.events[0]?.actionable, true);
});

test('a failure with no problems listed still alerts', () => {
  const r = rig([{ ...OK, ok: false, problems: [] }]);
  assert.match(r.at(T0).events[0]?.summary ?? '', /maintain reported a failure/);
});

test('realIo runs maintain with the day, the container and a budget, and reads the result line', () => {
  let seen: string[] = [];
  const run: Run = (_cmd, args) => { seen = args; return { status: 0, stdout: `archived 1 finished item(s)\n${maintainLine(OK)}\n`, stderr: '' }; };
  assert.deepEqual(maint.realIo.maintain('/box', '2026-10-09', run), OK);
  assert.deepEqual(seen.slice(1), ['maintain', '--today', '2026-10-09', '--container', '/box', '--budget', String(maint.SWEEP_BUDGET_SECONDS)]);
});

test('realIo turns a run that printed no result into an error that names the exit and the last line', () => {
  const run: Run = () => ({ status: 1, stdout: '', stderr: 'Error: ledger root is not set\n' });
  assert.throws(() => maint.realIo.maintain('/box', '2026-10-09', run), /no result \(exit 1: Error: ledger root is not set\)/);
});

test('validate refuses a target that is not a directory', () => {
  assert.throws(() => maint.validate(join(tmpdir(), 'no-such-dir-roll-maint')), /container directory/);
  assert.doesNotThrow(() => maint.validate(mkdtempSync(join(tmpdir(), 'rm-'))));
});

test('in the loop: success is silent, a failure is an actionable event, and the type is a singleton standing watch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-loop-'));
  const target = mkdtempSync(join(tmpdir(), 'rm-box-'));
  const answers: (MaintainResult | Error)[] = [OK, { ...OK, ok: false, problems: ['no container'] }];
  const io: MaintenanceIo = { localDay: (n) => new Date(n).toISOString().slice(0, 10), maintain: () => answers.shift() as MaintainResult };
  const types = { ...BUILTIN_TYPES, 'roll-maintenance': { ...maint, check: (t: string, c: Parameters<typeof maint.check>[1]) => maint.check(t, c, io) } };
  addWatch(dir, { id: 'rm', type: 'roll-maintenance', target, done_when: '', report: '', notify_overnight: false, notify: false, interval: null, renew: true }, T0);
  const config = { quietHours: 'off' };
  const quiet = tick({ dir, types, ctx: { run: noRun }, config, now: T0 });
  assert.deepEqual(quiet.events, []);
  const failed = tick({ dir, types, ctx: { run: noRun }, config, now: T0 + 25 * HOUR });
  assert.deepEqual(failed.events.map((e) => [e.summary, e.actionable]), [['roll maintenance failed: no container', true]]);
  assert.equal(maint.singleton, true);
  assert.equal(listWatches(dir).length, 1);
});

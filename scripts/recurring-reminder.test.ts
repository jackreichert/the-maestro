// Run: node --test scripts/recurring-reminder.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tick } from './event-loop.ts';
import * as reminder from './event-types/reminder.ts';
import * as wake from './event-types/wake.ts';
import { parseRecurring } from './lib/recurring-time.ts';
import { isStanding } from './lib/standing-watch.ts';
import { cronFor, parseWakeTarget, wakeScheduleLines } from './lib/wake-schedule.ts';
import { addWatch, listWatches } from './lib/watch-registry.ts';
import { cleanEnv } from './lib/test-env.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = 'weekdays@08:30 America/New_York';
const DAY = 24 * 3600 * 1000;
const setup = () => ({ dir: mkdtempSync(join(tmpdir(), 'recurring-')), types: { reminder, wake }, config: { quietHours: 'off' }, ctx: { run: () => { throw new Error('no commands'); } } });
const z = (iso: string) => Date.parse(iso);
const add = (dir: string, at: string, over: Record<string, unknown> = {}) =>
  addWatch(dir, { id: 'standup', type: 'reminder', target: TARGET, report: 'prep', ttlMs: 7 * DAY, renew: true, ...over }, z(at));
const fires = (s: ReturnType<typeof setup>, at: string) => tick({ ...s, now: z(at) }).events.length;

test('the grammar parses weekdays and daily, and refuses a bad zone, a bad time or an other shape', () => {
  assert.deepEqual(parseRecurring(TARGET), { days: 'weekdays', minutes: 510, zone: 'America/New_York' });
  assert.equal(parseRecurring('daily@00:05 UTC')?.minutes, 5);
  assert.equal(parseRecurring('2026-10-03T15:00:00Z'), null);
  assert.throws(() => reminder.validate('weekdays@08:30 Mars/Olympus', { now: 0 }), /unknown time zone/);
  assert.throws(() => reminder.validate('weekdays@25:00 UTC', { now: 0 }), /outside 00:00-23:59/);
  assert.throws(() => reminder.validate('weekdays@08:60 UTC', { now: 0 }), /outside 00:00-23:59/);
  assert.throws(() => reminder.validate('weekdays@8:30 UTC', { now: 0 }), /weekdays@08:30/);
  assert.throws(() => wake.validate('daily@08:30', { now: 0 }), /daily@08:30 America\/New_York/);
  assert.doesNotThrow(() => reminder.validate(TARGET, { now: 0, ttlMs: 3600000 }));
  assert.doesNotThrow(() => wake.validate('daily@08:30 UTC', { now: 0 }));
});

test('weekdays fire on a weekday after the time and never on a weekend; the one-shot form still works', () => {
  const s = setup();
  add(s.dir, '2026-10-09T11:00:00Z'); // Friday 07:00 EDT
  assert.equal(fires(s, '2026-10-09T12:29:00Z'), 0, 'before 08:30 EDT');
  assert.equal(fires(s, '2026-10-09T12:31:00Z'), 1);
  assert.equal(fires(s, '2026-10-10T14:00:00Z'), 0, 'Saturday');
  assert.equal(fires(s, '2026-10-11T14:00:00Z'), 0, 'Sunday');
  const monday = tick({ ...s, now: z('2026-10-12T12:31:00Z') });
  assert.deepEqual(monday.events.map((e) => e.summary), ['reminder: prep']);
  const once = setup();
  addWatch(once.dir, { id: 'o', type: 'reminder', target: '2026-10-09T13:00:00Z', report: 'x' }, z('2026-10-09T11:00:00Z'));
  assert.equal(tick({ ...once, now: z('2026-10-09T13:01:00Z') }).retired.length, 1);
});

test('daily fires on weekends too', () => {
  const s = setup();
  add(s.dir, '2026-10-09T11:00:00Z', { id: 'd', target: 'daily@08:30 America/New_York' });
  assert.equal(fires(s, '2026-10-10T12:31:00Z'), 1, 'Saturday');
});

test('fall back (2026-11-01): the wall clock holds at 08:30, so the UTC instant moves an hour', () => {
  const s = setup();
  add(s.dir, '2026-10-30T11:00:00Z');
  assert.equal(fires(s, '2026-10-30T12:31:00Z'), 1, 'Friday, EDT: 12:30Z');
  assert.equal(fires(s, '2026-11-02T12:31:00Z'), 0, 'Monday 07:31 EST: a fixed -4 offset would fire here');
  assert.equal(fires(s, '2026-11-02T13:29:00Z'), 0, 'Monday 08:29 EST');
  assert.equal(fires(s, '2026-11-02T13:31:00Z'), 1, 'Monday 08:31 EST: 13:30Z');
  const d = setup();
  add(d.dir, '2026-10-31T11:00:00Z', { target: 'daily@08:30 America/New_York' });
  assert.equal(fires(d, '2026-11-01T12:31:00Z'), 0, 'the change day itself: 07:31 EST');
  assert.equal(fires(d, '2026-11-01T13:31:00Z'), 1);
});

test('spring forward (2027-03-14): 08:30 is 12:30Z in EDT', () => {
  const d = setup();
  add(d.dir, '2027-03-13T11:00:00Z', { target: 'daily@08:30 America/New_York' });
  assert.equal(fires(d, '2027-03-14T12:29:00Z'), 0);
  assert.equal(fires(d, '2027-03-14T12:31:00Z'), 1);
});

test('at most one fire per local day, however many ticks follow', () => {
  const s = setup();
  add(s.dir, '2026-10-12T10:00:00Z');
  assert.equal(fires(s, '2026-10-12T12:31:00Z'), 1);
  for (const t of ['2026-10-12T12:32:00Z', '2026-10-12T15:00:00Z', '2026-10-12T23:59:00Z']) assert.equal(fires(s, t), 0, t);
  assert.equal(fires(s, '2026-10-13T12:31:00Z'), 1, 'the next day fires again');
});

test('a recurring reminder re-arms instead of retiring, and its lifetime renews', () => {
  const s = setup();
  add(s.dir, '2026-10-12T10:00:00Z');
  const first = tick({ ...s, now: z('2026-10-12T12:31:00Z') });
  assert.deepEqual(first.retired, []);
  const later = tick({ ...s, now: z('2026-10-16T12:31:00Z') });
  assert.equal(later.events.length, 1);
  const [w] = listWatches(s.dir);
  assert.ok(Date.parse(w.expires) >= z('2026-10-16T12:31:00Z') + 6 * DAY, `expires ${w.expires}`);
  assert.equal(isStanding(reminder, TARGET), true);
  assert.equal(isStanding(reminder, '2026-10-12T12:00:00Z'), false);
  assert.equal(isStanding(wake, 'hourly:7'), false);
});

test('a loop that was down fires one catch-up the same day, never a backlog, and a watch added after the slot waits for tomorrow', () => {
  const s = setup();
  add(s.dir, '2026-10-12T10:00:00Z'); // Monday 06:00 EDT
  assert.equal(fires(s, '2026-10-12T20:00:00Z'), 1, 'loop back at 16:00 EDT: one catch-up');
  assert.equal(fires(s, '2026-10-12T21:00:00Z'), 0);
  assert.equal(fires(s, '2026-10-16T20:00:00Z'), 1, 'down Tue-Thu, back Friday: one event, not four');
  const late = setup();
  add(late.dir, '2026-10-12T15:00:00Z'); // Monday 11:00 EDT, after the slot
  assert.equal(fires(late, '2026-10-12T16:00:00Z'), 0);
  assert.equal(fires(late, '2026-10-13T12:31:00Z'), 1);
});

test('a recurring wake fires the same way and does not retire', () => {
  const s = setup();
  add(s.dir, '2026-10-12T10:00:00Z', { type: 'wake', id: 'w' });
  assert.equal(fires(s, '2026-10-12T12:29:00Z'), 0);
  const out = tick({ ...s, now: z('2026-10-12T12:31:00Z') });
  assert.deepEqual([out.events.map((e) => e.summary), out.retired], [['wake: prep'], []]);
  assert.equal(fires(s, '2026-10-12T13:00:00Z'), 0);
  assert.equal(isStanding(wake, TARGET), true);
});

test('the wake schedule lists a recurring target; the cron mirror is local time and only for the machine zone', () => {
  const now = z('2026-10-12T10:00:00Z');
  const w = { op: 'add', id: 'w', type: 'wake', target: TARGET, report: 'prep', created: '', expires: '2026-10-20T00:00:00Z' } as never;
  assert.deepEqual(wakeScheduleLines([w], now), ['Wake schedule (the event loop fires these):', `- Wake w: ${TARGET} - prep`]);
  const t = parseWakeTarget(TARGET);
  assert.ok(t);
  assert.equal(cronFor(t, now, 'America/New_York'), '30 8 * * 1-5');
  assert.equal(cronFor(t, now, 'UTC'), '', 'cron has no zone: no mirror unless the machine zone matches');
  assert.equal(cronFor(parseWakeTarget('daily@23:05 UTC')!, now, 'UTC'), '5 23 * * *');
  assert.equal(parseWakeTarget('weekdays@08:30 Nowhere/Land'), null);
});

test('add through the CLI refuses a bad zone and registers a good one as standing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recurring-cli-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'event-loop.ts'), ...args], { encoding: 'utf8', env: { ...cleanEnv(), MAESTRO_EVENT_DIR: dir } });
  assert.notEqual(cli('add', '--id', 'bad', '--type', 'reminder', '--target', 'weekdays@08:30 Mars/Olympus').status, 0);
  assert.equal(cli('add', '--id', 'ok', '--type', 'reminder', '--target', TARGET, '--report', 'prep').status, 0);
  assert.equal(listWatches(dir)[0].renew, true);
});

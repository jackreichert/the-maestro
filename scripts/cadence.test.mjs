// Run: node --test scripts/cadence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorSeconds, nextInterval, parseQuietHours, watchFloor, watchInterval } from './lib/cadence.mjs';

const MIN = 60000;
const at = (iso) => Date.parse(iso);
// 2026-10-01 is a Thursday; 2026-10-03 is a Saturday. Every case reads the clock in UTC.
const NOON = at('2026-10-01T12:00:00Z');
const ago = (now, ...minutes) => minutes.map((m) => now - m * MIN);

const CASES = [
  { name: 'three events in the window: high activity at min_interval', now: NOON, events: ago(NOON, 1, 5, 20), want: { seconds: 300, reason: /high activity: 3 event/ } },
  { name: 'two events: some activity', now: NOON, events: ago(NOON, 1, 5), want: { seconds: 600, reason: /some activity: 2 event/ } },
  { name: 'one event 25 minutes ago still counts', now: NOON, events: ago(NOON, 25), want: { seconds: 600, reason: /some activity/ } },
  { name: 'an event 45 minutes ago is outside the window and not yet idle enough to back off', now: NOON, events: ago(NOON, 45), config: { watchingSince: NOON - 300 * MIN }, want: { seconds: 600, reason: /steady/ } },
  { name: 'just started with no events: steady', now: NOON, events: [], config: { watchingSince: NOON }, want: { seconds: 600, reason: /steady/ } },
  { name: 'quiet for an hour: back off to 900', now: NOON, events: ago(NOON, 70), want: { seconds: 900, reason: /quiet for 1h/ } },
  { name: 'quiet for two hours: back off to 1800', now: NOON, events: ago(NOON, 130), want: { seconds: 1800, reason: /quiet for 2h/ } },
  { name: 'no events since the watcher started an hour ago: 900', now: NOON, events: [], config: { watchingSince: NOON - 61 * MIN }, want: { seconds: 900, reason: /quiet for 1h/ } },
  { name: 'a stored event older than a restart still measures idleness, not the restart time', now: NOON, events: ago(NOON, 70), config: { watchingSince: NOON }, want: { seconds: 900, reason: /quiet for 1h/ } },
  { name: 'events from the future are ignored', now: NOON, events: [NOON + 5 * MIN], config: { watchingSince: NOON }, want: { seconds: 600, reason: /steady/ } },
  { name: 'min_interval below the 300 floor is raised to 300', now: NOON, events: ago(NOON, 1, 2, 3), config: { minInterval: 60 }, want: { seconds: 300, reason: /high activity/ } },
  { name: 'min_interval above 300 is honoured for high activity', now: NOON, events: ago(NOON, 1, 2, 3), config: { minInterval: 450 }, want: { seconds: 450, reason: /high activity/ } },
  { name: 'min_interval above a tier lifts that tier to the floor', now: NOON, events: ago(NOON, 1), config: { minInterval: 900 }, want: { seconds: 900, reason: /some activity/ } },
  { name: 'max_interval caps the slowest backoff', now: NOON, events: ago(NOON, 130), config: { maxInterval: 700 }, want: { seconds: 700, reason: /quiet for 2h/ } },
  { name: 'max_interval below the floor cannot undercut it', now: NOON, events: ago(NOON, 130), config: { maxInterval: 10 }, want: { seconds: 300, reason: /quiet for 2h/ } },
  { name: 'the window length is configurable', now: NOON, events: ago(NOON, 1, 2, 50), config: { windowMinutes: 60 }, want: { seconds: 300, reason: /3 event\(s\) in 60m/ } },
  { name: 'overnight, stop mode: exit with a reason', now: at('2026-10-01T21:00:00Z'), events: ago(at('2026-10-01T21:00:00Z'), 1, 2, 3), want: { stop: true, reason: 'quiet hours' } },
  { name: 'early morning is still quiet', now: at('2026-10-01T06:59:00Z'), want: { stop: true, reason: 'quiet hours' } },
  { name: 'quiet hours end at 07:00', now: at('2026-10-01T07:00:00Z'), config: { watchingSince: at('2026-10-01T07:00:00Z') }, want: { seconds: 600, reason: /steady/ } },
  { name: 'quiet hours begin at 20:00', now: at('2026-10-01T20:00:00Z'), want: { stop: true, reason: 'quiet hours' } },
  { name: 'overnight, slow mode: 1800', now: at('2026-10-01T23:30:00Z'), config: { quietMode: 'slow' }, want: { seconds: 1800, reason: 'quiet hours (slow)' } },
  { name: 'overnight, slow mode respects max_interval', now: at('2026-10-02T02:00:00Z'), config: { quietMode: 'slow', maxInterval: 900 }, want: { seconds: 900, reason: 'quiet hours (slow)' } },
  { name: 'an unknown mode behaves as stop', now: at('2026-10-01T23:00:00Z'), config: { quietMode: 'later' }, want: { stop: true, reason: 'quiet hours' } },
  { name: 'custom quiet window that does not wrap', now: at('2026-10-01T13:30:00Z'), config: { quietHours: '13:00-14:00' }, want: { stop: true, reason: 'quiet hours' } },
  { name: 'quiet hours off: night is like any hour', now: at('2026-10-01T23:00:00Z'), config: { quietHours: 'off', watchingSince: at('2026-10-01T23:00:00Z') }, want: { seconds: 600, reason: /steady/ } },
  { name: 'weekend with the option on: stop all day', now: at('2026-10-03T12:00:00Z'), config: { quietWeekends: true }, want: { stop: true, reason: 'quiet hours' } },
  { name: 'weekend with the option on and slow mode: 1800', now: at('2026-10-04T12:00:00Z'), config: { quietWeekends: true, quietMode: 'slow' }, want: { seconds: 1800, reason: 'quiet hours (slow)' } },
  { name: 'weekend with the option off: a normal day', now: at('2026-10-03T12:00:00Z'), config: { watchingSince: at('2026-10-03T12:00:00Z') }, want: { seconds: 600, reason: /steady/ } },
  { name: 'quiet hours are read in watch_tz (Tokyo is 05:00 next day)', now: at('2026-10-01T20:00:00Z'), config: { tz: 'Asia/Tokyo' }, want: { stop: true, reason: 'quiet hours' } },
  { name: 'the same instant is daytime in another zone', now: at('2026-10-01T20:00:00Z'), config: { tz: 'America/New_York', watchingSince: at('2026-10-01T20:00:00Z') }, want: { seconds: 600, reason: /steady/ } },
  { name: '--interval above the floor pins the cadence', now: NOON, events: ago(NOON, 1, 2, 3), config: { pinned: 900 }, want: { seconds: 900, reason: 'pinned by --interval' } },
  { name: '--interval under 300 is raised to the floor', now: NOON, events: ago(NOON, 1, 2, 3), config: { pinned: 120 }, want: { seconds: 300, reason: 'pinned by --interval (raised to 300)' } },
  { name: '--interval under watch_min_interval is raised to it', now: NOON, config: { pinned: 400, minInterval: 450 }, want: { seconds: 450, reason: 'pinned by --interval (raised to 450)' } },
  { name: '--interval does not run overnight: quiet hours still stop', now: at('2026-10-01T23:00:00Z'), events: ago(at('2026-10-01T23:00:00Z'), 1, 2, 3), config: { pinned: 900 }, want: { stop: true, reason: 'quiet hours' } },
];

for (const c of CASES) {
  test(c.name, () => {
    const got = nextInterval({ now: c.now, recentEvents: c.events ?? [], config: { tz: 'UTC', ...c.config } });
    for (const [key, expected] of Object.entries(c.want)) {
      if (expected instanceof RegExp) assert.match(got[key], expected);
      else assert.equal(got[key], expected, JSON.stringify(got));
    }
    assert.equal('stop' in got, 'stop' in c.want);
  });
}

test('now may be a Date', () => {
  assert.equal(nextInterval({ now: new Date(NOON), recentEvents: ago(NOON, 1, 2, 3), config: { tz: 'UTC' } }).seconds, 300);
});

test('parseQuietHours accepts HH:MM-HH:MM and rejects everything else', () => {
  assert.deepEqual(parseQuietHours('20:00-07:00'), { start: 1200, end: 420 });
  assert.deepEqual(parseQuietHours(' 8:05 - 9:10 '), { start: 485, end: 550 });
  for (const bad of ['off', '', undefined, '25:00-07:00', '20:60-07:00', '20-7']) assert.equal(parseQuietHours(bad), null);
});

test('floorSeconds is 300 unless watch_min_interval is higher', () => {
  assert.equal(floorSeconds({}), 300);
  assert.equal(floorSeconds({ minInterval: 60 }), 300);
  assert.equal(floorSeconds({ minInterval: 450 }), 450);
});

test('a quiet stop says when quiet hours end, in the configured zone', () => {
  const got = nextInterval({ now: at('2026-10-01T21:00:00Z'), config: { tz: 'UTC' } });
  assert.deepEqual([got.until, got.tz], ['07:00', 'UTC']);
});

test('a weekend stop resumes at the end of the weekend', () => {
  const got = nextInterval({ now: at('2026-10-03T12:00:00Z'), config: { tz: 'UTC', quietWeekends: true } });
  assert.equal(got.until, '07:00');
});

test('quiet hours in another zone resume in that zone', () => {
  const got = nextInterval({ now: at('2026-10-01T20:00:00Z'), config: { tz: 'Asia/Tokyo' } });
  assert.deepEqual([got.until, got.tz], ['07:00', 'Asia/Tokyo']);
});

test('watchFloor: 120s for network or undeclared types, 30s for local ones; a setting can only raise it', () => {
  assert.equal(watchFloor({ network: true }), 120);
  assert.equal(watchFloor({}), 120);
  assert.equal(watchFloor({ network: false }), 30);
  assert.equal(watchFloor({ network: true }, { networkFloor: 10 }), 120);
  assert.equal(watchFloor({ network: false }, { localFloor: 1 }), 30);
  assert.equal(watchFloor({ network: true }, { networkFloor: 300 }), 300);
  assert.equal(watchFloor({ network: false }, { localFloor: 45 }), 45);
});

const W = (args) => watchInterval({ now: NOON, ...args });

test('watchInterval: override beats config beats the type default, and nothing goes under the floor', () => {
  const net = { interval: 180, network: true };
  assert.equal(W({ type: 't', spec: net }).seconds, 180);
  assert.equal(W({ type: 't', spec: net, config: { typeIntervals: { t: 240 } } }).seconds, 240);
  assert.equal(W({ type: 't', spec: net, override: 400, config: { typeIntervals: { t: 240 } } }).seconds, 400);
  const low = W({ type: 't', spec: net, override: 5 });
  assert.equal(low.seconds, 120);
  assert.match(low.reason, /raised to the 120s floor/);
  assert.equal(W({ type: 't', spec: { interval: 60, network: false }, override: 2 }).seconds, 30);
  assert.equal(W({ type: 't', spec: { interval: 1, network: true } }).seconds, 120);
  assert.equal(W({ type: 't' }).seconds, 180, 'no spec at all: default interval, network floor');
});

test('watchInterval: idle stretches the interval, the cap never undercuts it, and backoff = false opts out', () => {
  const net = { interval: 180, network: true };
  const idle = (minutes) => [NOON - minutes * MIN];
  assert.equal(W({ spec: net, recentEvents: idle(70) }).seconds, 270);
  assert.equal(W({ spec: net, recentEvents: idle(130) }).seconds, 540);
  assert.equal(W({ spec: net, recentEvents: idle(130), config: { maxInterval: 300 } }).seconds, 300);
  assert.equal(W({ spec: { ...net, interval: 400 }, recentEvents: idle(130), config: { maxInterval: 300 } }).seconds, 400);
  assert.equal(W({ spec: net, recentEvents: ago(NOON, 1, 2, 3) }).seconds, 180);
  assert.equal(W({ spec: { interval: 30, network: false, backoff: false }, recentEvents: idle(130) }).seconds, 30);
});

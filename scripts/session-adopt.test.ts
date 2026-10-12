import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptionBlock, waiterLines } from './lib/session-adopt.ts';
import { cronFor, cronMirrorLines, parseWakeTarget, wakeScheduleLines } from './lib/wake-schedule.ts';
import type { Watch } from './lib/types.ts';

const NOW = Date.parse('2026-10-11T20:00:00Z');
const wake = (over: Partial<Watch>): Watch => ({ op: 'add', id: 'w1', type: 'wake', target: 'hourly:7,37', done_when: '', report: 'work the queue', notify_overnight: false, notify: false, interval: null, created: '', expires: '2026-10-12T20:00:00.000Z', ...over });
const adopt = { file: '/q/queue.md', until: '2026-10-12T20:00:00.000Z', at: '' };

test('parseWakeTarget reads hourly minutes and ISO times, nothing else', () => {
  assert.deepEqual(parseWakeTarget('hourly:7,37'), { kind: 'hourly', minutes: [7, 37] });
  assert.deepEqual(parseWakeTarget('2026-10-12T01:00:00Z'), { kind: 'once', at: Date.parse('2026-10-12T01:00:00Z') });
  assert.equal(parseWakeTarget('hourly:75'), null);
  assert.equal(parseWakeTarget('hourly:'), null);
  assert.equal(parseWakeTarget('whenever'), null);
});

test('the schedule lists live wakes only: other types, expired and unparsable ones are skipped', () => {
  const lines = wakeScheduleLines([wake({}), wake({ id: 'old', expires: '2026-10-11T00:00:00Z' }), wake({ id: 'odd', target: 'whenever' }), wake({ id: 'r', type: 'reminder' })], NOW);
  assert.deepEqual(lines, ['Wake schedule (the event loop fires these):', '- Wake w1: hourly:7,37 - work the queue']);
  assert.deepEqual(wakeScheduleLines([], NOW), []);
});

test('a secret-shaped prompt is withheld in the schedule and the cron mirror', () => {
  const bad = wake({ report: 'use AKIAIOSFODNN7EXAMPLE now' });
  assert.ok(!wakeScheduleLines([bad], NOW).join('\n').includes('AKIA'));
  assert.ok(!cronMirrorLines([bad], NOW).join('\n').includes('AKIA'));
});

test('cronFor: hourly is a minute list, a past one-shot is dropped', () => {
  assert.equal(cronFor({ kind: 'hourly', minutes: [7, 37] }, NOW), '7,37 * * * *');
  assert.equal(cronFor({ kind: 'once', at: NOW - 1 }, NOW), '');
  assert.match(cronFor({ kind: 'once', at: NOW + 3600_000 }, NOW), /^\d+ \d+ \d+ \d+ \*$/);
});

test('with the loop up the block has the queue and schedule but no cron mirror', () => {
  const text = adoptionBlock({ adopt, watches: [wake({})], loop: 'ok', now: NOW });
  assert.match(text, /^Adopted queue: \/q\/queue.md/);
  assert.match(text, /Wake w1: hourly:7,37/);
  assert.ok(!text.includes('CronCreate'));
});

test('with the loop down the block adds one CronCreate call per wake', () => {
  for (const loop of ['down', 'stalled', 'not-installed', 'absent'] as const) {
    const text = adoptionBlock({ adopt: null, watches: [wake({}), wake({ id: 'w2', target: '2026-10-12T01:00:00Z' })], loop, now: NOW });
    assert.equal(text.split('\n').filter((l) => l.includes('CronCreate')).length, 2, loop);
    assert.match(text, /cron="7,37 \* \* \* \*" prompt="work the queue"/);
    assert.match(text, /recurring=false/);
  }
});

test('nothing adopted and no wakes prints nothing', () => {
  assert.equal(adoptionBlock({ adopt: null, watches: [], loop: 'down', now: NOW }), '');
  assert.deepEqual(waiterLines(), []);
});

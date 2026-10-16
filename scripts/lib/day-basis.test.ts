// Run: node --test scripts/lib/day-basis.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askAgeDays, clock, ledgerDay, userDay } from './day-basis.ts';

// 2026-10-12T00:18Z is already the 12th in UTC and Tokyo, still the evening of the 11th in New York.
const AFTER_UTC_MIDNIGHT = new Date('2026-10-12T00:18:00Z');

test('ledgerDay is the UTC day and userDay the calendar day in the zone, across UTC midnight in New York and Tokyo', () => {
  assert.equal(ledgerDay(AFTER_UTC_MIDNIGHT), '2026-10-12');
  assert.equal(userDay('America/New_York', AFTER_UTC_MIDNIGHT), '2026-10-11');
  assert.equal(userDay('Asia/Tokyo', AFTER_UTC_MIDNIGHT), '2026-10-12');
  const lateTokyo = new Date('2026-10-11T23:30:00Z');
  assert.deepEqual([ledgerDay(lateTokyo), userDay('Asia/Tokyo', lateTokyo), userDay('America/New_York', lateTokyo)], ['2026-10-11', '2026-10-12', '2026-10-11']);
});

test('clock honours MAESTRO_NOW and ignores a value that is not a time', () => {
  assert.equal(clock({ MAESTRO_NOW: '2026-10-12T00:18:00Z' }).toISOString(), '2026-10-12T00:18:00.000Z');
  const before = Date.now();
  assert.ok(clock({ MAESTRO_NOW: 'not a time' }).getTime() >= before);
  assert.ok(clock({}).getTime() >= before);
});

test('an ask written at 8:30 pm New York time is 0 days old that evening and 1 day old the next, in any viewing zone of the page', () => {
  const ask = { ts: '2026-10-12T00:30:00Z', date: '2026-10-12' };
  assert.equal(askAgeDays(ask, new Date('2026-10-12T01:00:00Z'), 'America/New_York'), 0);
  assert.equal(askAgeDays(ask, new Date('2026-10-12T14:00:00Z'), 'America/New_York'), 1);
});

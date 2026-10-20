// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/working-time.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workingMs } from './working-time.ts';

const NY = 'America/New_York';
const H = 3_600_000;
// 2026-10-16 is a Friday; 2026-10-19 a Monday (US Eastern is UTC-4 in October).
const at = (iso: string): number => Date.parse(iso);

test('a weekday stretch counts in full', () => {
  assert.equal(workingMs(at('2026-10-19T14:00:00Z'), at('2026-10-20T14:00:00Z'), NY), 24 * H);
});

test('Friday evening to Monday evening is one working day: the weekend does not count', () => {
  assert.equal(workingMs(at('2026-10-16T21:00:00Z'), at('2026-10-19T21:00:00Z'), NY), 24 * H);
});

test('a span wholly inside the weekend is zero', () => {
  assert.equal(workingMs(at('2026-10-17T16:00:00Z'), at('2026-10-18T16:00:00Z'), NY), 0);
});

test('the day is cut at local midnight, not UTC midnight', () => {
  // Friday 23:00 ET is Saturday 03:00 UTC: one working hour until local midnight, then Saturday.
  assert.equal(workingMs(at('2026-10-17T03:00:00Z'), at('2026-10-17T12:00:00Z'), NY), H);
});

test('a later end than start is required; bad times are NaN', () => {
  assert.equal(workingMs(at('2026-10-20T14:00:00Z'), at('2026-10-19T14:00:00Z'), NY), 0);
  assert.ok(Number.isNaN(workingMs(Number.NaN, 1, NY)));
});

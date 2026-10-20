// Run: MAESTRO_LOCAL_CONFIG='' node --test scripts/lib/teammate/others-drop.test.ts
process.env.MAESTRO_LOCAL_CONFIG ??= '';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitingAuthor, dropGate, droppedForQuiet, lastActivity } from './others-drop.ts';

const gate = dropGate('America/New_York', { openHours: 0, activeHours: 0, dropDays: 2 });
const t = (iso: string): number => Date.parse(iso);
const pr = { createdAt: '2026-10-01T12:00:00Z' };
// 2026-10-16 is a Friday, 2026-10-19 a Monday, 2026-10-21 a Wednesday (Eastern is UTC-4).

test('two working days of quiet drops a PR', () => {
  assert.equal(droppedForQuiet(pr, t('2026-10-19T14:00:00Z'), t('2026-10-21T15:00:00Z'), gate), true);
  assert.equal(droppedForQuiet(pr, t('2026-10-19T14:00:00Z'), t('2026-10-21T13:00:00Z'), gate), false);
});

test('a weekend does not count: quiet since Friday afternoon is not dropped on Tuesday morning, but is by Wednesday', () => {
  const friday = t('2026-10-16T20:00:00Z');
  assert.equal(droppedForQuiet(pr, friday, t('2026-10-20T12:00:00Z'), gate), false, 'Tuesday 08:00 ET: about 1.5 working days');
  assert.equal(droppedForQuiet(pr, friday, t('2026-10-21T14:00:00Z'), gate), true, 'Wednesday 10:00 ET: past two working days');
});

test('a PR opened inside the open window is never dropped', () => {
  const g = dropGate('America/New_York', { openHours: 72, activeHours: 0, dropDays: 2 });
  assert.equal(droppedForQuiet({ createdAt: '2026-10-20T12:00:00Z' }, t('2026-10-16T12:00:00Z'), t('2026-10-21T12:00:00Z'), g), false);
});

test('the drop window is never shorter than the active window', () => {
  const g = dropGate('America/New_York', { openHours: 0, activeHours: 96, dropDays: 2 });
  assert.equal(droppedForQuiet(pr, t('2026-10-19T14:00:00Z'), t('2026-10-21T15:00:00Z'), g), false);
});

test('a PR waiting on its author is not dropped for being quiet, and is dropped again once the author pushes and goes quiet', () => {
  const waiting = { ...pr, yourReview: { state: 'COMMENTED', at: '2026-10-19T14:00:00Z' }, headAt: '2026-10-19T10:00:00Z' };
  assert.equal(awaitingAuthor(waiting), true);
  assert.equal(droppedForQuiet(waiting, t('2026-10-19T14:00:00Z'), t('2026-10-30T14:00:00Z'), gate), false);
  const pushed = { ...waiting, headAt: '2026-10-20T10:00:00Z' };
  assert.equal(awaitingAuthor(pushed), false);
  assert.equal(droppedForQuiet(pushed, t('2026-10-20T10:00:00Z'), t('2026-10-30T14:00:00Z'), gate), true);
});

test('an approving review is not waiting on the author', () => {
  assert.equal(awaitingAuthor({ yourReview: { state: 'APPROVED', at: '2026-10-19T14:00:00Z' }, headAt: '2026-10-19T10:00:00Z' }), false);
});

test('unknown activity is not dropped, and the newest of several times is the last activity', () => {
  assert.equal(droppedForQuiet(pr, Number.NaN, t('2026-10-30T14:00:00Z'), gate), false);
  assert.equal(lastActivity('2026-10-19T14:00:00Z', 5, undefined, '2026-10-20T00:00:00Z'), t('2026-10-20T00:00:00Z'));
  assert.ok(Number.isNaN(lastActivity(undefined, 'nope')));
});

test('a disabled drop setting drops nothing', () => {
  assert.equal(droppedForQuiet(pr, t('2026-10-01T00:00:00Z'), t('2026-10-30T14:00:00Z'), dropGate('UTC', {})), false);
});
